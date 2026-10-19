"""
OrderFlow Unified xlwings Bridge
================================
Single bridge for:
  - TAS / trade-and-sales
  - TAQ / quote-based
  - CF / Pro single-display format

One WebSocket:
    ws://localhost:8766

Features:
  * Select MANY Excel workbooks in one picker.
  * Auto-detect TAS / TAQ / CF from workbook headers.
  * Poll all selected/open workbooks concurrently.
  * Each browser tab subscribes to one source type.
  * Each tab can independently choose which live workbook to display.
  * No need to run three Python processes or three ports.

Run:
    python -u xlwings_orderflow_unified_bridge.py
    python -u xlwings_orderflow_unified_bridge.py file1.xlsm file2.xlsx ...
    python -u xlwings_orderflow_unified_bridge.py --interval 0.25 --port 8766
"""

from __future__ import annotations
import argparse, asyncio, json, logging, math, os, re, sys, threading, queue, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import xlwings as xw
    import pandas as pd
    import numpy as np
    import websockets
except ImportError as exc:
    print("Missing dependency:", exc)
    print("Run: pip install xlwings pandas numpy openpyxl websockets")
    raise SystemExit(1)

try:
    import pywintypes
    COM_ERR = pywintypes.com_error
except Exception:
    COM_ERR = OSError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("orderflow-unified")

# ---------------------------------------------------------------------
# Embed the user's three proven bridges without running their __main__.
# ---------------------------------------------------------------------
_TAS_SOURCE = '"""\nxlwings_bridge_tas_live_tail_v8.py — Fast WebSocket Bridge for OrderFlow Trader TAS Pro\n\nMain speed improvement:\n  - Does NOT reread the whole Excel sheet every poll.\n  - Reads only newly appended Excel rows after the first seed read.\n  - Caches workbook, sheet, headers, and column boundary.\n  - Broadcasts only new ticks.\n  - Keeps snapshot support for newly connected HTML clients.\n\nUse:\n  python xlwings_bridge_tas_live_tail_v8.py\n  python xlwings_bridge_tas_live_tail_v8.py "C:\\\\path\\\\file.xlsm" --interval 0.25\n\nDefault WebSocket:\n  ws://localhost:8766\n"""\nfrom __future__ import annotations\n\nimport argparse\nimport asyncio\nimport json\nimport logging\nimport math\nimport os\nimport re\nimport sys\nfrom datetime import datetime, time as dtime, date as ddate\nfrom pathlib import Path\nfrom typing import Any\n\n\ndef _check(pkg: str, pip_name: str | None = None):\n    try:\n        return __import__(pkg)\n    except ImportError:\n        print(f"Missing: {pkg}. Run: pip install {pip_name or pkg}")\n        sys.exit(1)\n\nnp = _check("numpy")\npd = _check("pandas")\nxw = _check("xlwings")\nwebsockets = _check("websockets")\n\ntry:\n    import pywintypes\n    COM_ERR = pywintypes.com_error\nexcept Exception:\n    COM_ERR = OSError\n\ntry:\n    WS_VERSION = tuple(int(x) for x in websockets.__version__.split(".")[:2])\nexcept Exception:\n    WS_VERSION = (10, 0)\n\nlogging.basicConfig(\n    level=logging.INFO,\n    format="%(asctime)s  %(levelname)-8s  %(message)s",\n    datefmt="%H:%M:%S",\n)\nlog = logging.getLogger("tas-bridge-v7")\n\nWS_HOST = "localhost"\nWS_PORT = 8766\nCHECK_INTERVAL = 0.25\nHEADER_ROW = 3\nDATA_START_ROW = 4\nCALC_EVERY_N = 0          # 0 = do not force Excel calculate from bridge\nFULL_RESEED_ON_ROW_DROP = True\nMAX_WS_SIZE = 2 ** 25     # 32 MB\nTAIL_SCAN_ROWS = 500      # important for Refinitiv live tables that update/shift without growing rows\n\n_clients: set[Any] = set()\n_file_states: dict[str, "FileState"] = {}\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# Safe JSON helpers\n# ─────────────────────────────────────────────────────────────────────────────\ndef safe_num(v: Any, default: float = 0.0) -> float:\n    if v is None:\n        return default\n    try:\n        f = float(v)\n        return default if math.isnan(f) or math.isinf(f) else f\n    except Exception:\n        return default\n\n\ndef safe_str(v: Any, default: str = "") -> str:\n    if v is None:\n        return default\n    s = str(v).strip()\n    return default if s.lower() in ("", "nan", "none", "nat") else s\n\n\ndef sanitize_json_value(obj: Any) -> Any:\n    if isinstance(obj, float):\n        return 0 if math.isnan(obj) or math.isinf(obj) else obj\n    if isinstance(obj, dict):\n        return {k: sanitize_json_value(v) for k, v in obj.items()}\n    if isinstance(obj, (list, tuple)):\n        return [sanitize_json_value(v) for v in obj]\n    if hasattr(obj, "item"):\n        try:\n            return sanitize_json_value(obj.item())\n        except Exception:\n            return obj\n    return obj\n\n\ndef safe_json(obj: Any) -> str:\n    return json.dumps(sanitize_json_value(obj), separators=(",", ":"), ensure_ascii=False)\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# Time parsing\n# ─────────────────────────────────────────────────────────────────────────────\nMONTH_MAP = {\n    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",\n    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",\n    "fév": "02", "fev": "02", "avr": "04", "mai": "05", "aoû": "08", "aou": "08",\n    "déc": "12", "juil": "07", "mär": "03", "okt": "10", "dez": "12",\n    "ene": "01", "abr": "04", "ago": "08", "dic": "12",\n    "gen": "01", "mag": "05", "giu": "06", "lug": "07", "set": "09", "ott": "10",\n}\n\n\ndef _excel_time_to_hms(v: Any) -> str:\n    if isinstance(v, datetime):\n        return v.strftime("%H:%M:%S")\n    if isinstance(v, dtime):\n        return v.strftime("%H:%M:%S")\n    if isinstance(v, (int, float)) and not math.isnan(float(v)):\n        frac = float(v) % 1\n        secs = int(round(frac * 86400)) % 86400\n        h, rem = divmod(secs, 3600)\n        m, s = divmod(rem, 60)\n        return f"{h:02d}:{m:02d}:{s:02d}"\n    s = safe_str(v)\n    m = re.search(r"(\\d{1,2}):(\\d{2})(?::(\\d{2}))?", s)\n    if not m:\n        return ""\n    return f"{int(m.group(1)):02d}:{int(m.group(2)):02d}:{int(m.group(3) or 0):02d}"\n\n\ndef _excel_date_to_ymd(v: Any) -> str:\n    if isinstance(v, datetime):\n        return v.strftime("%Y-%m-%d")\n    if isinstance(v, ddate):\n        return v.strftime("%Y-%m-%d")\n    s = safe_str(v)\n    m = re.search(r"(\\d{4})-(\\d{2})-(\\d{2})", s)\n    if m:\n        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"\n    m = re.search(r"(\\d{1,2})-([A-Za-z\\u00c0-\\u024f]{2,4})-(\\d{2,4})", s)\n    if m:\n        mon_raw = m.group(2).lower()\n        mon_key = mon_raw.encode("ascii", "ignore").decode()\n        mon = MONTH_MAP.get(mon_raw) or MONTH_MAP.get(mon_key) or "01"\n        yr = m.group(3)\n        yr = "20" + yr if len(yr) == 2 else yr\n        return f"{yr}-{mon}-{m.group(1).zfill(2)}"\n    return ""\n\n\ndef parse_timestamp(ts_val: Any, active_date: Any = None, timeact_ns: Any = None) -> tuple[str, str]:\n    # Refinitiv live format: ACTIVE DATE + TIMEACT NS\n    if active_date is not None or timeact_ns is not None:\n        t = _excel_time_to_hms(timeact_ns)\n        d = _excel_date_to_ymd(active_date)\n        if t or d:\n            return t, d\n\n    if isinstance(ts_val, (pd.Timestamp, datetime)):\n        return ts_val.strftime("%H:%M:%S"), ts_val.strftime("%Y-%m-%d")\n    if isinstance(ts_val, (int, float)) and not math.isnan(float(ts_val)):\n        return _excel_time_to_hms(ts_val), ""\n\n    s = safe_str(ts_val)\n    return _excel_time_to_hms(s), _excel_date_to_ymd(s)\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# TAS row conversion, optimized for appended rows\n# ─────────────────────────────────────────────────────────────────────────────\nREQUIRED_COLS = ["TRDPRC_1", "BID", "ASK", "BIDSIZE", "ASKSIZE", "TRDVOL_1", "AGGRS_SID1", "PRCTCK_1"]\nOPTIONAL_COLS = ["TRADE_ID", "SEQNUM", "RTL", "QUALIFIERS", "Timestamp", "TIMESTAMP", "ACTIVE DATE", "TIMEACT NS"]\nNUMERIC_COLS = ["TRDPRC_1", "BID", "ASK", "BIDSIZE", "ASKSIZE", "TRDVOL_1", "TRADE_ID", "SEQNUM", "RTL"]\nFFILL_COLS = ["BID", "ASK", "TRADE_ID", "SEQNUM", "RTL", "TRDPRC_1", "AGGRS_SID1", "PRCTCK_1"]\n\n\ndef norm_aggr(v: Any) -> str:\n    s = safe_str(v).upper()\n    if s in ("BID", "B", "1"):\n        return "BID"\n    if s in ("ASK", "A", "2", "S"):\n        return "ASK"\n    return s\n\n\ndef is_spl_qual(v: Any) -> bool:\n    s = re.sub(r"[^\\x20-\\x7E]", "", safe_str(v)).strip().upper()\n    return "SPL TRD" in s\n\n\nclass TasProcessor:\n    def __init__(self, source_path: str):\n        self.source_path = source_path\n        folder = os.path.dirname(source_path)\n        stem = Path(source_path).stem\n        self.cleaned_path = os.path.join(folder, f"{stem}_cleaned.xlsx")\n        self._cleaned_rows: list[dict] = []\n        self._last_values: dict[str, Any] = {}\n        self._spl_idx = 0\n        self.spl_trd = 0.0\n        self._seen_keys: set[str] = set()\n        # Forward-diff (shift(-1)) buffer: the newest row is emitted immediately\n        # with provisional final-row diffs; this tracks it until its successor\n        # arrives and its exact forward diffs can be patched in.\n        self._pending: dict | None = None  # {"row": dict, "raw": {TRADE_ID,SEQNUM,RTL}}\n        self._amended: list[dict] = []\n        self._chunk_gen = 0\n\n    def reset(self):\n        self._cleaned_rows.clear()\n        self._last_values.clear()\n        self._spl_idx = 0\n        self.spl_trd = 0.0\n        self._seen_keys.clear()\n        self._pending = None\n        self._amended = []\n        self._chunk_gen = 0\n\n    def process_chunk(self, df_raw: pd.DataFrame, *, reset: bool = False) -> tuple[list[dict], float]:\n        if reset:\n            self.reset()\n        if df_raw is None or df_raw.empty:\n            return [], self.spl_trd\n        self._chunk_gen += 1\n\n        df = df_raw.copy()\n        df.columns = [str(c).strip() if c is not None else "" for c in df.columns]\n        for c in REQUIRED_COLS + OPTIONAL_COLS:\n            if c not in df.columns:\n                df[c] = np.nan\n\n        df = df.replace(["", "nan", "NaN", "None", None], np.nan)\n\n        for c in NUMERIC_COLS:\n            df[c] = pd.to_numeric(df[c], errors="coerce")\n\n        # Forward-fill across poll chunks using last seen values.\n        for c in FFILL_COLS:\n            if c in df.columns:\n                if c in self._last_values and pd.isna(df[c].iloc[0]):\n                    df.loc[df.index[0], c] = self._last_values[c]\n                df[c] = df[c].ffill().bfill()\n                last_valid = df[c].dropna()\n                if not last_valid.empty:\n                    self._last_values[c] = last_valid.iloc[-1]\n\n        df["BIDSIZE"] = df["BIDSIZE"].fillna(0)\n        df["ASKSIZE"] = df["ASKSIZE"].fillna(0)\n        df["TRDVOL_1"] = df["TRDVOL_1"].fillna(0)\n\n        rows: list[dict] = []\n\n        def _last2(v: float) -> float:\n            # fillna_with_last_digits(orig, ..., digits=2): last 2 digits of the raw value.\n            try:\n                return float(int(abs(v)) % 100)\n            except Exception:\n                return 0.0\n\n        def _fwd_diff(cur_raw: float, next_raw: float) -> float:\n            # Plain forward diff (diff().abs().shift(-1)): |next - cur|.\n            # A side that is missing (<=0 after coercion) behaves like pandas NaN:\n            # the diff is untrustworthy -> fillna_with_last_digits -> fillna(0).\n            if cur_raw <= 0 or next_raw <= 0:\n                return _last2(cur_raw)\n            return abs(next_raw - cur_raw)\n\n        def _finalize_pending(next_raw: dict) -> dict:\n            # Row i\'s diffs become known when row i+1 arrives (shift(-1) semantics).\n            # The row was ALREADY emitted (no display delay); patch it in place —\n            # state.all_rows and _cleaned_rows hold this same dict, so snapshots and\n            # the saved cleaned file automatically carry the exact final values —\n            # and queue it as an amendment for clients that already received it.\n            pend = self._pending\n            praw = pend["raw"]\n            trd_id_diff = _fwd_diff(praw["TRADE_ID"], next_raw["TRADE_ID"])\n            seq_diff = _fwd_diff(praw["SEQNUM"], next_raw["SEQNUM"])\n            # RTL smart logic: np.where(diff_rtl > 10000, orig, diff_rtl)\n            if praw["RTL"] > 0 and next_raw["RTL"] > 0:\n                d = abs(next_raw["RTL"] - praw["RTL"])\n                rtl_diff = praw["RTL"] if d > 10000 else d\n            else:\n                rtl_diff = _last2(praw["RTL"])\n            row = pend["row"]\n            changed = (row["trdIdDiff"] != trd_id_diff or row["seqNumDiff"] != seq_diff\n                       or row["movesDiff"] != rtl_diff)\n            row["trdIdDiff"] = trd_id_diff\n            row["seqNumDiff"] = seq_diff\n            row["movesDiff"] = rtl_diff\n            # Rows finalized within the same chunk they were emitted in already\n            # leave the bridge with final values — no amendment needed for those.\n            if changed and pend.get("gen") != self._chunk_gen:\n                self._amended.append(row)\n            self._pending = None\n            return row\n\n        for _, r in df.iterrows():\n            qual = safe_str(r.get("QUALIFIERS"))\n            spl = is_spl_qual(qual)\n            last = safe_num(r.get("TRDPRC_1"))\n\n            # Keep price rows and SPL TRD rows only.\n            if not (last > 0 or spl):\n                continue\n\n            cur = self._raw_diff_state(r)\n\n            bid = safe_num(r.get("BID"))\n            ask = safe_num(r.get("ASK"))\n            b_size = safe_num(r.get("BIDSIZE"))\n            a_size = safe_num(r.get("ASKSIZE"))\n            trd_vol = safe_num(r.get("TRDVOL_1"))\n            trade_id_value = r.get("TRADE_ID")\n            trade_id = safe_num(trade_id_value)\n\n            if spl:\n                trade_key = f"spl:{self._spl_idx}"\n                bid = ask = b_size = a_size = 0.0\n                last = 0.0\n            else:\n                trade_key = str(int(trade_id)) if pd.notna(trade_id_value) else ""\n\n            ts_val = r.get("Timestamp") if pd.notna(r.get("Timestamp")) else r.get("TIMESTAMP")\n            time_str, date_str = parse_timestamp(ts_val, r.get("ACTIVE DATE"), r.get("TIMEACT NS"))\n\n            # Dedup: tail-mode rescans re-feed rows that were already processed.\n            # A re-fed row is skipped ENTIRELY — in particular it must NOT finalize\n            # the pending row (the pending row is the NEWEST sheet row; re-fed rows\n            # are OLD rows, and diffing the newest against an old raw would corrupt it).\n            # Stable TAS source identity for tail rescans.\n            # IMPORTANT: build it from the normalized SOURCE columns, before any\n            # SPL-TRD display substitutions can erase TRADE_ID/SEQNUM/RTL/price.\n            # This collapses only truly identical normalized TAS source rows.\n            dedup_key = safe_json({\n                "kind": "tas-source",\n                "date": date_str,\n                "time": time_str,\n                "tick": safe_str(r.get("PRCTCK_1")),\n                "aggr": norm_aggr(r.get("AGGRS_SID1")),\n                "last": safe_num(r.get("TRDPRC_1")),\n                "bid": safe_num(r.get("BID")),\n                "ask": safe_num(r.get("ASK")),\n                "bSize": safe_num(r.get("BIDSIZE")),\n                "aSize": safe_num(r.get("ASKSIZE")),\n                "trdVol": safe_num(r.get("TRDVOL_1")),\n                "tradeId": (str(int(safe_num(r.get("TRADE_ID"))))\n                            if pd.notna(r.get("TRADE_ID")) else ""),\n                "seqNum": safe_num(r.get("SEQNUM")),\n                "rtl": safe_num(r.get("RTL")),\n                "qualifier": qual,\n            })\n            if dedup_key in self._seen_keys:\n                continue\n            self._seen_keys.add(dedup_key)\n\n            # A genuinely NEW row is by construction the sheet row right after the\n            # pending one, so it finalizes the pending row\'s forward diffs (in place,\n            # already emitted — no re-emit here).\n            if self._pending is not None:\n                _finalize_pending(cur)\n\n            if spl:\n                self.spl_trd += trd_vol\n                self._spl_idx += 1\n\n            row = {\n                "last": last,\n                "bid": bid,\n                "ask": ask,\n                "bSize": b_size,\n                "aSize": a_size,\n                "trdVol": trd_vol,\n                "volume": trd_vol,\n                "aggr": norm_aggr(r.get("AGGRS_SID1")),\n                # Full normalized source identity already used by TasProcessor.\n                # Carry it forward so FileState and backend canonical dedupe use\n                # the exact same event identity and cannot collapse valid rows.\n                "sourceKey": dedup_key,\n                "tradeId": trade_key,\n                # Exact source TRADE_ID for canonical/raw storage. SPL display\n                # rows may use tradeId="spl:N", but rawTradeId stays source-true.\n                "rawTradeId": (str(int(trade_id)) if pd.notna(trade_id_value) else ""),\n                "seqNum": safe_num(r.get("SEQNUM")),\n                "moves": safe_num(r.get("RTL")),\n                "rtCount": safe_num(r.get("RTL")),\n                # Provisional final-row diffs (fillna_with_last_digits semantics) —\n                # exactly what manual processing shows for the newest row at this\n                # instant; finalized in place when the successor row arrives.\n                "trdIdDiff": _last2(cur["TRADE_ID"]),\n                "seqNumDiff": _last2(cur["SEQNUM"]),\n                "movesDiff": _last2(cur["RTL"]),\n                "volDiff": trd_vol,\n                "condKey": qual,\n                "QUALIFIERS": qual,\n                "time": time_str,\n                "date": date_str,\n            }\n            # Emit immediately — the newest tick shows in the app with no delay.\n            rows.append(row)\n            self._cleaned_rows.append(row)\n            self._pending = {"row": row, "raw": cur, "gen": self._chunk_gen}\n\n        return rows, self.spl_trd\n\n    def pop_amended(self) -> list[dict]:\n        """Rows whose forward diffs were finalized after they were emitted."""\n        out, self._amended = self._amended, []\n        return out\n\n    def flush_pending(self) -> dict | None:\n        """Confirm the newest row\'s provisional diffs as final (manual final-row\n        semantics: shift(-1) yields NaN -> fillna_with_last_digits). The row was\n        already emitted and already sits in the cleaned rows — nothing is appended."""\n        if self._pending is None:\n            return None\n        row = self._pending["row"]  # provisional values ARE the final-row values\n        self._pending = None\n        return row\n\n    @staticmethod\n    def _raw_diff_state(r: pd.Series) -> dict[str, float]:\n        return {\n            "TRADE_ID": safe_num(r.get("TRADE_ID")),\n            "SEQNUM": safe_num(r.get("SEQNUM")),\n            "RTL": safe_num(r.get("RTL")),\n        }\n\n    def save_cleaned(self) -> str | None:\n        # Include the buffered newest row with manual final-row semantics\n        # (shift(-1) → NaN → fillna_with_last_digits) so the file isn\'t one short.\n        self.flush_pending()\n        if not self._cleaned_rows:\n            log.warning("No cleaned rows to save yet.")\n            return None\n        try:\n            pd.DataFrame(self._cleaned_rows).to_excel(self.cleaned_path, index=False)\n            log.info("Saved: %s", self.cleaned_path)\n            return self.cleaned_path\n        except Exception as exc:\n            log.error("Save failed: %s", exc)\n            return None\n\n\nclass FileState:\n    def __init__(self, path: str):\n        self.path = path\n        raw_name = os.path.basename(path)\n        self.name = raw_name[2:] if raw_name.startswith("~$") else raw_name\n        self.processor = TasProcessor(path)\n        self.known_ids: set[str] = set()\n        self.all_rows: list[dict] = []\n        self.last_spl_trd = 0.0\n        self._wb_ref: Any = None\n        self._sheet_ref: Any = None\n        self._hdr_cache: list[str] | None = None\n        self._last_col = 0\n        self._last_excel_row = DATA_START_ROW - 1  # last ACTIVE data row (not used_range)\n        self._calc_cycle = 0\n        self._com_fails = 0\n        self._last_tail_signature: str = ""\n        self._order: str = "asc"  # auto-detected each poll: \'asc\' | \'desc\'\n        self.pending_amends: list[dict] = []\n\n    def reset_data(self):\n        self.known_ids.clear()\n        self.all_rows.clear()\n        self.last_spl_trd = 0.0\n        self._last_excel_row = DATA_START_ROW - 1\n        self._last_tail_signature = ""\n        self.pending_amends.clear()\n        self.processor.reset()\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# Excel helpers\n# ─────────────────────────────────────────────────────────────────────────────\ndef _clean_path(raw: str) -> str:\n    p = Path(raw).resolve()\n    if p.name.startswith("~$"):\n        real = p.parent / p.name[2:]\n        if real.exists():\n            return str(real)\n    return str(p)\n\n\ndef _col_letter(n: int) -> str:\n    s = ""\n    while n:\n        n, rem = divmod(n - 1, 26)\n        s = chr(65 + rem) + s\n    return s\n\n\ndef _find_workbook(path: str):\n    try:\n        books = list(xw.books)\n    except Exception:\n        return None\n    target = os.path.basename(path).lower().lstrip("~$")\n    for book in books:\n        try:\n            full = str(book.fullname)\n            bn = os.path.basename(full).lower().lstrip("~$")\n            if bn == target or full.lower() == path.lower():\n                return book\n        except Exception:\n            continue\n    real = []\n    for book in books:\n        try:\n            name = os.path.basename(str(book.fullname))\n            if not name.startswith("~$") and not name.startswith("Book"):\n                real.append(book)\n        except Exception:\n            pass\n    return real[0] if len(real) == 1 else None\n\n\ndef _validate_wb(wb: Any) -> bool:\n    try:\n        _ = wb.name\n        return True\n    except Exception:\n        return False\n\n\ndef _row_key(r: dict) -> str:\n    # V4: use the exact full normalized TAS source identity created in process_chunk.\n    # This makes processor dedupe and FileState dedupe identical.\n    source_key = safe_str(r.get("sourceKey"))\n    if source_key:\n        return source_key\n\n    # Compatibility fallback for any legacy row without sourceKey.\n    raw_tid = safe_str(r.get("rawTradeId"))\n    tid = raw_tid if raw_tid else safe_str(r.get("tradeId"))\n    return safe_json({\n        "kind": "tas-row-fallback",\n        "date": safe_str(r.get("date")),\n        "time": safe_str(r.get("time")),\n        "tradeId": tid,\n        "seqNum": safe_num(r.get("seqNum")),\n        "rtl": safe_num(r.get("moves")),\n        "last": safe_num(r.get("last")),\n        "bid": safe_num(r.get("bid")),\n        "ask": safe_num(r.get("ask")),\n        "bSize": safe_num(r.get("bSize")),\n        "aSize": safe_num(r.get("aSize")),\n        "trdVol": safe_num(r.get("trdVol")),\n        "aggr": safe_str(r.get("aggr")),\n        "qualifier": safe_str(r.get("condKey") or r.get("QUALIFIERS")),\n    })\n\n\ndef _get_workbook_and_sheet(state: FileState):\n    wb = state._wb_ref\n    if wb is not None and not _validate_wb(wb):\n        state._wb_ref = None\n        state._sheet_ref = None\n        state._hdr_cache = None\n        wb = None\n    if wb is None:\n        wb = _find_workbook(state.path)\n        if wb is None:\n            return None, None\n        state._wb_ref = wb\n        state._sheet_ref = None\n        state._hdr_cache = None\n    if state._sheet_ref is None:\n        try:\n            state._sheet_ref = wb.sheets[0]\n        except Exception:\n            state._wb_ref = None\n            state._sheet_ref = None\n            return None, None\n    return wb, state._sheet_ref\n\n\ndef _read_headers_if_needed(state: FileState, sheet: Any, last_col: int) -> list[str] | None:\n    if state._hdr_cache is not None and state._last_col == last_col:\n        return state._hdr_cache\n    end_col = _col_letter(last_col)\n    try:\n        raw = sheet.range(f"A{HEADER_ROW}:{end_col}{HEADER_ROW}").value or []\n    except Exception:\n        state._hdr_cache = None\n        return None\n    if not isinstance(raw, list):\n        raw = [raw]\n    headers = [str(h).strip() if h is not None else "" for h in raw]\n    state._hdr_cache = headers\n    state._last_col = last_col\n    return headers\n\n\ndef _make_df(data: Any, headers: list[str]) -> pd.DataFrame:\n    if data is None:\n        return pd.DataFrame(columns=headers)\n    if data and not isinstance(data[0], list):\n        data = [data]\n    rows = [r for r in data if r and any(c is not None for c in r)]\n    if not rows:\n        return pd.DataFrame(columns=headers)\n    fixed = []\n    n = len(headers)\n    for r in rows:\n        if len(r) < n:\n            r = list(r) + [None] * (n - len(r))\n        elif len(r) > n:\n            r = list(r)[:n]\n        fixed.append(r)\n    return pd.DataFrame(fixed, columns=headers)\n\n\ndef _raw_signature(data: Any, last_n: int = 8, *, head: bool = False) -> str:\n    """Small signature of the changing edge of the Excel table.\n    Refinitiv live functions often update rows in-place or shift a fixed RET range,\n    so last_row does not always increase. This signature lets us detect those\n    in-place changes and still broadcast new rows. For DESC tables (newest rows at\n    the top) the changing edge is the HEAD of the window instead of the tail.\n    """\n    if data is None:\n        return ""\n    try:\n        rows = data if isinstance(data, list) else [data]\n        if rows and not isinstance(rows[0], list):\n            rows = [rows]\n        edge = rows[:last_n] if head else rows[-last_n:]\n        return repr(edge)\n    except Exception:\n        return repr(data)\n\n\ndef _detect_order(ts_values: list) -> str | None:\n    """Detect whether the timestamp column runs oldest→newest (\'asc\') or\n    newest→oldest (\'desc\'). Returns None when undecidable (e.g. all equal)."""\n    vals = [v for v in ts_values if v is not None and str(v).strip() != ""]\n    if len(vals) < 2:\n        return None\n\n    def _norm(v):\n        # Refinitiv timestamps often end in ":mmm" (e.g. "13-jul-26 10:00:10:010"),\n        # which pandas can\'t parse — convert the final colon to a decimal point.\n        s = str(v).strip()\n        return re.sub(r\'(\\d{1,2}:\\d{2}:\\d{2}):(\\d{1,3})\\s*$\', r\'\\1.\\2\', s)\n\n    vals = [v if isinstance(v, (datetime, pd.Timestamp)) else _norm(v) for v in vals]\n    try:\n        import warnings\n        with warnings.catch_warnings():\n            warnings.simplefilter("ignore")\n            s = pd.to_datetime(pd.Series([vals[0], vals[-1]]), errors="coerce", dayfirst=True)\n            a, b = s.iloc[0], s.iloc[1]\n            if pd.notna(a) and pd.notna(b) and a != b:\n                return "asc" if a < b else "desc"\n            # Endpoints equal/unparseable → look at the full sample.\n            s2 = pd.to_datetime(pd.Series(vals), errors="coerce", dayfirst=True).dropna()\n        if len(s2) < 2 or s2.nunique() < 2:\n            return None\n        if s2.is_monotonic_increasing:\n            return "asc"\n        if s2.is_monotonic_decreasing:\n            return "desc"\n        # Mixed/noisy: compare first vs last valid stamps.\n        return "asc" if s2.iloc[0] <= s2.iloc[-1] else "desc"\n    except Exception:\n        return None\n\n\ndef _active_extent(ts_values: list) -> int | None:\n    """Index (0-based within the read column) of the last row that actually has a\n    timestamp. Fixed RFV windows pre-allocate the block, so used_range covers far\n    more rows than the data that has arrived; scanning from used_range\'s bottom\n    would only ever see blank padding."""\n    for i in range(len(ts_values) - 1, -1, -1):\n        v = ts_values[i]\n        if v is not None and str(v).strip() != "":\n            return i\n    return None\n\n\ndef read_rows_for(state: FileState, *, seed: bool = False) -> list[dict] | None:\n    wb, sheet = _get_workbook_and_sheet(state)\n    if wb is None or sheet is None:\n        return None\n\n    if CALC_EVERY_N and CALC_EVERY_N > 0:\n        state._calc_cycle = (state._calc_cycle + 1) % CALC_EVERY_N\n        if state._calc_cycle == 0:\n            try:\n                wb.app.calculate()\n            except Exception:\n                pass\n\n    try:\n        used = sheet.used_range\n        last_col = int(used.last_cell.column)\n        last_row = int(used.last_cell.row)\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n\n    if last_row < DATA_START_ROW:\n        return []\n\n    headers = _read_headers_if_needed(state, sheet, last_col)\n    if not headers:\n        return []\n\n    end_col = _col_letter(last_col)\n\n    # Locate the ACTIVE data extent from the timestamp column. Fixed RFV windows\n    # (START..END) pre-allocate the whole block and fill it in-place, so\n    # used_range\'s last row stays constant and its bottom rows are blank padding —\n    # scanning there sees no change and the app freezes at the seed snapshot.\n    try:\n        ts_raw = sheet.range(f"A{DATA_START_ROW}:A{last_row}").value\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n    if not isinstance(ts_raw, list):\n        ts_raw = [ts_raw]\n    ext = _active_extent(ts_raw)\n    if ext is None:\n        return []\n    active_last = DATA_START_ROW + ext\n\n    # Auto-detect row ordering (ASC: newest appended at the bottom;\n    # DESC: newest inserted at the top). Sticky when undecidable.\n    order = _detect_order(ts_raw[: ext + 1]) or state._order\n    if order != state._order:\n        log.info("[%s] Detected %s row order", state.name, order.upper())\n        state._order = order\n\n    if active_last < state._last_excel_row and FULL_RESEED_ON_ROW_DROP:\n        log.info("[%s] Active data extent dropped; reseeding snapshot", state.name)\n        state.reset_data()\n\n    tail_mode = False\n    if seed or state._last_excel_row < DATA_START_ROW:\n        # Full seed: read the entire active extent.\n        start_row, end_row = DATA_START_ROW, active_last\n        reset_processor = True\n    elif order == "asc":\n        reset_processor = False\n        if active_last > state._last_excel_row:\n            # Fast path: read only the newly appended rows.\n            start_row, end_row = state._last_excel_row + 1, active_last\n        else:\n            # No growth: rescan the tail of the ACTIVE extent for in-place updates.\n            tail_mode = True\n            end_row = active_last\n            start_row = max(DATA_START_ROW, active_last - TAIL_SCAN_ROWS + 1)\n    else:\n        # DESC: new rows appear at the TOP and shift the block down. Scan a head\n        # window sized to cover the growth plus an overlap; the processor\'s\n        # internal dedup drops the re-fed older rows.\n        reset_processor = False\n        tail_mode = True\n        grown = max(0, active_last - state._last_excel_row)\n        depth = min(active_last - DATA_START_ROW + 1, TAIL_SCAN_ROWS + grown)\n        start_row = DATA_START_ROW\n        end_row = DATA_START_ROW + depth - 1\n\n    try:\n        data = sheet.range(f"A{start_row}:{end_col}{end_row}").value\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n\n    # In rescan modes, skip processing unless the changing edge actually changed.\n    # For DESC tables the changing edge is the head of the window, not the tail.\n    if tail_mode:\n        sig = _raw_signature(data, head=(order == "desc"))\n        if sig == state._last_tail_signature:\n            state._last_excel_row = active_last\n            return []\n        state._last_tail_signature = sig\n    else:\n        state._last_tail_signature = _raw_signature(data, head=(order == "desc"))\n\n    state._last_excel_row = active_last\n\n    # The processor (forward diff) requires chronological order: oldest → newest.\n    if order == "desc" and isinstance(data, list):\n        if data and not isinstance(data[0], list):\n            data = [data]\n        data = list(reversed(data))\n\n    df = _make_df(data, headers)\n    if df.empty:\n        return []\n\n    try:\n        rows, spl_trd = state.processor.process_chunk(df, reset=reset_processor)\n    except Exception as exc:\n        log.error("[%s] process_chunk failed: %s", state.name, exc, exc_info=True)\n        return []\n\n    state.last_spl_trd = spl_trd\n    # Rows finalized after emission (their exact forward diffs are now known);\n    # staged for an \'amend\' broadcast so connected clients converge to exact values.\n    state.pending_amends.extend(state.processor.pop_amended())\n    new_rows = []\n    for r in rows:\n        k = _row_key(r)\n        if k in state.known_ids:\n            continue\n        state.known_ids.add(k)\n        state.all_rows.append(r)\n        new_rows.append(r)\n    return new_rows\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# WebSocket server\n# ─────────────────────────────────────────────────────────────────────────────\nasync def _send(ws: Any, obj: Any):\n    try:\n        await ws.send(safe_json(obj))\n    except Exception:\n        pass\n\n\nasync def _broadcast(obj: Any):\n    if not _clients:\n        return\n    msg = safe_json(obj)\n    dead = set()\n    for ws in list(_clients):\n        try:\n            await ws.send(msg)\n        except Exception:\n            dead.add(ws)\n    _clients.difference_update(dead)\n\n\nasync def _ws_handler(ws: Any, path: str | None = None):\n    _clients.add(ws)\n    remote = getattr(ws, "remote_address", "?")\n    log.info("Client connected: %s total=%d", remote, len(_clients))\n    try:\n        await _send(ws, {\n            "type": "connected",\n            "server": "xlwings-bridge-tas",\n            "version": "8.1-fwd-diff-active-extent",\n            "files": [s.name for s in _file_states.values()],\n            "file": ", ".join(s.name for s in _file_states.values()),\n        })\n        for state in _file_states.values():\n            if state.all_rows:\n                await _send(ws, {\n                    "type": "snapshot",\n                    "file": state.name,\n                    "rows": state.all_rows,\n                    "total": len(state.all_rows),\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                    "splTrd": state.last_spl_trd,\n                })\n        async for raw in ws:\n            try:\n                msg = json.loads(raw)\n                cmd = msg.get("type") or msg.get("cmd")\n                if cmd == "ping":\n                    await _send(ws, {"type": "pong", "ts": datetime.now().strftime("%H:%M:%S")})\n                elif cmd == "save":\n                    results = {s.name: s.processor.save_cleaned() for s in _file_states.values()}\n                    await _send(ws, {"type": "saved", "ok": any(results.values()), "files": results})\n                elif cmd == "resync":\n                    for s in _file_states.values():\n                        s.reset_data()\n                        read_rows_for(s, seed=True)\n                    await _send(ws, {"type": "resynced", "ok": True})\n            except Exception:\n                continue\n    except Exception:\n        pass\n    finally:\n        _clients.discard(ws)\n        log.info("Client disconnected: %s", remote)\n\n\nasync def _poll_loop():\n    cycle = 0\n    warned: set[str] = set()\n    log.info("Polling %d file(s) every %.2fs", len(_file_states), CHECK_INTERVAL)\n    while True:\n        await asyncio.sleep(CHECK_INTERVAL)\n        cycle += 1\n        for path, state in _file_states.items():\n            try:\n                new_rows = read_rows_for(state)\n            except COM_ERR as exc:\n                state._com_fails += 1\n                state._wb_ref = None\n                state._sheet_ref = None\n                if state._com_fails <= 3 or state._com_fails % 20 == 0:\n                    log.warning("[%s] Excel busy x%d: %s", state.name, state._com_fails, str(exc)[:90])\n                continue\n            except Exception as exc:\n                state._wb_ref = None\n                state._sheet_ref = None\n                log.error("[%s] Poll error: %s", state.name, exc, exc_info=True)\n                continue\n\n            if new_rows is None:\n                if path not in warned or cycle % 40 == 0:\n                    log.warning("[%s] Not open in Excel yet — waiting…", state.name)\n                    warned.add(path)\n                continue\n\n            if state._com_fails:\n                log.info("[%s] Excel COM recovered after %d failures", state.name, state._com_fails)\n                state._com_fails = 0\n            warned.discard(path)\n\n            if new_rows:\n                await _broadcast({\n                    "type": "ticks",\n                    "file": state.name,\n                    "rows": new_rows,\n                    "total": len(state.all_rows),\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                    "splTrd": state.last_spl_trd,\n                })\n                log.info("Cycle %5d [%s] +%d rows total=%d splTrd=%.0f",\n                         cycle, state.name, len(new_rows), len(state.all_rows), state.last_spl_trd)\n\n            if state.pending_amends:\n                amends, state.pending_amends = state.pending_amends, []\n                await _broadcast({\n                    "type": "amend",\n                    "file": state.name,\n                    "rows": [{"key": _row_key(r),\n                              "tradeId": r.get("tradeId"), "time": r.get("time"),\n                              "last": r.get("last"),\n                              "trdIdDiff": r.get("trdIdDiff"),\n                              "seqNumDiff": r.get("seqNumDiff"),\n                              "movesDiff": r.get("movesDiff")} for r in amends],\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                })\n\n        if cycle % max(1, int(5 / max(CHECK_INTERVAL, 0.05))) == 0:\n            await _broadcast({\n                "type": "heartbeat",\n                "files": {p: {"name": s.name, "rows": len(s.all_rows), "splTrd": s.last_spl_trd}\n                          for p, s in _file_states.items()},\n                "clients": len(_clients),\n                "ts": datetime.now().strftime("%H:%M:%S"),\n            })\n\n\nasync def _start_server():\n    kwargs = {\n        "ping_interval": 30,\n        "ping_timeout": 10,\n        "close_timeout": 5,\n        "max_size": MAX_WS_SIZE,\n    }\n    if WS_VERSION >= (14, 0):\n        async def handler_v14(ws):\n            await _ws_handler(ws)\n        async with websockets.serve(handler_v14, WS_HOST, WS_PORT, **kwargs):\n            log.info("ws://%s:%d ready", WS_HOST, WS_PORT)\n            await _poll_loop()\n    else:\n        try:\n            from websockets.server import serve as ws_serve\n        except Exception:\n            from websockets import serve as ws_serve\n        async with ws_serve(_ws_handler, WS_HOST, WS_PORT, **kwargs):\n            log.info("ws://%s:%d ready", WS_HOST, WS_PORT)\n            await _poll_loop()\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# File picker / main\n# ─────────────────────────────────────────────────────────────────────────────\ndef select_files(cli_files: list[str]) -> list[str]:\n    if cli_files:\n        paths = [_clean_path(p) for p in cli_files]\n        missing = [p for p in paths if not Path(p).exists()]\n        if missing:\n            log.error("Not found: %s", missing)\n            sys.exit(1)\n        return paths\n    try:\n        import tkinter as tk\n        from tkinter import filedialog\n        root = tk.Tk()\n        root.withdraw()\n        chosen = filedialog.askopenfilenames(\n            title="Select TAS Excel file",\n            filetypes=[("Excel", "*.xlsx *.xlsm *.xls"), ("CSV", "*.csv"), ("All", "*.*")],\n        )\n        root.destroy()\n        if not chosen:\n            sys.exit(0)\n        return [_clean_path(p) for p in chosen]\n    except Exception as exc:\n        log.error("File picker failed: %s", exc)\n        sys.exit(1)\n\n\nasync def _main():\n    global WS_PORT, CHECK_INTERVAL, HEADER_ROW, DATA_START_ROW, CALC_EVERY_N\n    parser = argparse.ArgumentParser(description="Optimized xlwings WebSocket bridge for TAS HTML")\n    parser.add_argument("files", nargs="*", help="Excel TAS file(s)")\n    parser.add_argument("--port", type=int, default=8766)\n    parser.add_argument("--interval", type=float, default=0.25, help="Poll interval seconds; try 0.25 or 0.3")\n    parser.add_argument("--header-row", type=int, default=3)\n    parser.add_argument("--data-row", type=int, default=4)\n    parser.add_argument("--calc-every", type=int, default=0, help="Force Excel calculate every N polls; 0 disables")\n    args = parser.parse_args()\n\n    WS_PORT = args.port\n    CHECK_INTERVAL = max(0.05, args.interval)\n    HEADER_ROW = args.header_row\n    DATA_START_ROW = args.data_row\n    CALC_EVERY_N = max(0, args.calc_every)\n\n    files = select_files(args.files)\n    log.info("=" * 70)\n    log.info("OrderFlow Trader TAS — xlwings Bridge v8 live tail scan")\n    log.info("Reads appended rows + scans live tail for in-place Refinitiv updates. WebSocket: ws://%s:%d", WS_HOST, WS_PORT)\n    log.info("Poll interval: %.2fs | header row: %d | data row: %d | calc_every: %d",\n             CHECK_INTERVAL, HEADER_ROW, DATA_START_ROW, CALC_EVERY_N)\n    log.info("Files: %s", ", ".join(files))\n    log.info("Python: %s | websockets: %s", sys.version.split()[0], websockets.__version__)\n    log.info("=" * 70)\n\n    for p in files:\n        st = FileState(p)\n        _file_states[p] = st\n        wb = _find_workbook(p)\n        if wb is None:\n            log.warning("[%s] Not open in Excel yet — will wait", st.name)\n            continue\n        st._wb_ref = wb\n        log.info("[%s] Found workbook: %s", st.name, wb.fullname)\n        seed = read_rows_for(st, seed=True)\n        if seed:\n            log.info("[%s] Seeded %d rows", st.name, len(st.all_rows))\n\n    await _start_server()\n\n\nif __name__ == "__main__":\n    try:\n        asyncio.run(_main())\n    except KeyboardInterrupt:\n        log.info("Bridge stopped.")\n'
_TAQ_SOURCE = '"""\nxlwings_bridge_taq_live_tail_v8.py — Fast WebSocket Bridge for OrderFlow Trader TAS Pro\n\nMain speed improvement:\n  - Does NOT reread the whole Excel sheet every poll.\n  - Reads only newly appended Excel rows after the first seed read.\n  - Caches workbook, sheet, headers, and column boundary.\n  - Broadcasts only new ticks.\n  - Keeps snapshot support for newly connected HTML clients.\n\nUse:\n  python xlwings_bridge_tas_live_tail_v8.py\n  python xlwings_bridge_tas_live_tail_v8.py "C:\\\\path\\\\file.xlsm" --interval 0.25\n\nDefault WebSocket:\n  ws://localhost:8766\n"""\nfrom __future__ import annotations\n\nimport argparse\nimport asyncio\nimport json\nimport logging\nimport math\nimport os\nimport re\nimport sys\nfrom datetime import datetime, time as dtime, date as ddate\nfrom pathlib import Path\nfrom typing import Any\n\n\ndef _check(pkg: str, pip_name: str | None = None):\n    try:\n        return __import__(pkg)\n    except ImportError:\n        print(f"Missing: {pkg}. Run: pip install {pip_name or pkg}")\n        sys.exit(1)\n\nnp = _check("numpy")\npd = _check("pandas")\nxw = _check("xlwings")\nwebsockets = _check("websockets")\n\ntry:\n    import pywintypes\n    COM_ERR = pywintypes.com_error\nexcept Exception:\n    COM_ERR = OSError\n\ntry:\n    WS_VERSION = tuple(int(x) for x in websockets.__version__.split(".")[:2])\nexcept Exception:\n    WS_VERSION = (10, 0)\n\nlogging.basicConfig(\n    level=logging.INFO,\n    format="%(asctime)s  %(levelname)-8s  %(message)s",\n    datefmt="%H:%M:%S",\n)\nlog = logging.getLogger("tas-bridge-v7")\n\nWS_HOST = "localhost"\nWS_PORT = 8767          # TAS bridge uses 8766 — both can run together\nCHECK_INTERVAL = 0.25\nHEADER_ROW = 3\nDATA_START_ROW = 4\nCALC_EVERY_N = 0          # 0 = do not force Excel calculate from bridge\nFULL_RESEED_ON_ROW_DROP = True\nMAX_WS_SIZE = 2 ** 25     # 32 MB\nTAIL_SCAN_ROWS = 500      # important for Refinitiv live tables that update/shift without growing rows\n\n_clients: set[Any] = set()\n_file_states: dict[str, "FileState"] = {}\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# Safe JSON helpers\n# ─────────────────────────────────────────────────────────────────────────────\ndef safe_num(v: Any, default: float = 0.0) -> float:\n    if v is None:\n        return default\n    try:\n        f = float(v)\n        return default if math.isnan(f) or math.isinf(f) else f\n    except Exception:\n        return default\n\n\ndef safe_str(v: Any, default: str = "") -> str:\n    if v is None:\n        return default\n    s = str(v).strip()\n    return default if s.lower() in ("", "nan", "none", "nat") else s\n\n\ndef sanitize_json_value(obj: Any) -> Any:\n    if isinstance(obj, float):\n        return 0 if math.isnan(obj) or math.isinf(obj) else obj\n    if isinstance(obj, dict):\n        return {k: sanitize_json_value(v) for k, v in obj.items()}\n    if isinstance(obj, (list, tuple)):\n        return [sanitize_json_value(v) for v in obj]\n    if hasattr(obj, "item"):\n        try:\n            return sanitize_json_value(obj.item())\n        except Exception:\n            return obj\n    return obj\n\n\ndef safe_json(obj: Any) -> str:\n    return json.dumps(sanitize_json_value(obj), separators=(",", ":"), ensure_ascii=False)\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# Time parsing\n# ─────────────────────────────────────────────────────────────────────────────\nMONTH_MAP = {\n    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",\n    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",\n    "fév": "02", "fev": "02", "avr": "04", "mai": "05", "aoû": "08", "aou": "08",\n    "déc": "12", "juil": "07", "mär": "03", "okt": "10", "dez": "12",\n    "ene": "01", "abr": "04", "ago": "08", "dic": "12",\n    "gen": "01", "mag": "05", "giu": "06", "lug": "07", "set": "09", "ott": "10",\n}\n\n\ndef _excel_time_to_hms(v: Any) -> str:\n    if isinstance(v, datetime):\n        return v.strftime("%H:%M:%S")\n    if isinstance(v, dtime):\n        return v.strftime("%H:%M:%S")\n    if isinstance(v, (int, float)) and not math.isnan(float(v)):\n        frac = float(v) % 1\n        secs = int(round(frac * 86400)) % 86400\n        h, rem = divmod(secs, 3600)\n        m, s = divmod(rem, 60)\n        return f"{h:02d}:{m:02d}:{s:02d}"\n    s = safe_str(v)\n    m = re.search(r"(\\d{1,2}):(\\d{2})(?::(\\d{2}))?", s)\n    if not m:\n        return ""\n    return f"{int(m.group(1)):02d}:{int(m.group(2)):02d}:{int(m.group(3) or 0):02d}"\n\n\ndef _excel_date_to_ymd(v: Any) -> str:\n    if isinstance(v, datetime):\n        return v.strftime("%Y-%m-%d")\n    if isinstance(v, ddate):\n        return v.strftime("%Y-%m-%d")\n    s = safe_str(v)\n    m = re.search(r"(\\d{4})-(\\d{2})-(\\d{2})", s)\n    if m:\n        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"\n    m = re.search(r"(\\d{1,2})-([A-Za-z\\u00c0-\\u024f]{2,4})-(\\d{2,4})", s)\n    if m:\n        mon_raw = m.group(2).lower()\n        mon_key = mon_raw.encode("ascii", "ignore").decode()\n        mon = MONTH_MAP.get(mon_raw) or MONTH_MAP.get(mon_key) or "01"\n        yr = m.group(3)\n        yr = "20" + yr if len(yr) == 2 else yr\n        return f"{yr}-{mon}-{m.group(1).zfill(2)}"\n    return ""\n\n\ndef parse_timestamp(ts_val: Any, active_date: Any = None, timeact_ns: Any = None) -> tuple[str, str]:\n    # Refinitiv live format: ACTIVE DATE + TIMEACT NS\n    if active_date is not None or timeact_ns is not None:\n        t = _excel_time_to_hms(timeact_ns)\n        d = _excel_date_to_ymd(active_date)\n        if t or d:\n            return t, d\n\n    if isinstance(ts_val, (pd.Timestamp, datetime)):\n        return ts_val.strftime("%H:%M:%S"), ts_val.strftime("%Y-%m-%d")\n    if isinstance(ts_val, (int, float)) and not math.isnan(float(ts_val)):\n        return _excel_time_to_hms(ts_val), ""\n\n    s = safe_str(ts_val)\n    return _excel_time_to_hms(s), _excel_date_to_ymd(s)\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# TAS row conversion, optimized for appended rows\n# ─────────────────────────────────────────────────────────────────────────────\n# TAQ format: quote rows only — no TRDPRC_1 / AGGRS_SID1 / TRDVOL_1 / TRADE_ID.\n# Trade side, price and aggressor are DERIVED from QUALIFIERS per process_taq.py:\n#   "0[BID_COND_N]…" → ⇧ → price=BID, aggressor=BID (hit)\n#   "1[ASK_COND_N]…" → ⇩ → price=ASK, aggressor=ASK (lift)\n# SEQ_Diff / RT_Diff pre-computed sheet columns are IGNORED — diffs are always\n# recomputed with process_taq.py\'s exact semantics for mode-parity.\nREQUIRED_COLS = ["BID", "ASK", "BIDSIZE", "ASKSIZE", "SEQNUM", "RTL"]\nOPTIONAL_COLS = ["SEQ_Diff", "RT_Diff", "QUALIFIERS", "Timestamp", "TIMESTAMP", "ACTIVE DATE", "TIMEACT NS"]\nNUMERIC_COLS = ["BID", "ASK", "BIDSIZE", "ASKSIZE", "SEQNUM", "RTL", "SEQ_Diff", "RT_Diff"]\n# process_taq.py does NOT forward-fill SEQNUM/RTL — diffs run over raw values.\nFFILL_COLS = ["BID", "ASK"]\n\n\ndef norm_aggr(v: Any) -> str:\n    s = safe_str(v).upper()\n    if s in ("BID", "B", "1"):\n        return "BID"\n    if s in ("ASK", "A", "2", "S"):\n        return "ASK"\n    return s\n\n\ndef _taq_side(qual: str) -> str | None:\n    """process_taq.py map_qualifier: \'0[BID_COND_N]…\' → ⇧ , \'1[ASK_COND_N]…\' → ⇩ , else NaN."""\n    s = safe_str(qual).strip()\n    if s.startswith("0[BID_COND_N]"):\n        return "⇧"\n    if s.startswith("1[ASK_COND_N]"):\n        return "⇩"\n    return None\n\n\nclass TaqProcessor:\n    """WHOLE-WINDOW recompute of process_taq.py\'s convert_qualifiers().\n\n    TAQ live sheets are small fixed RFV windows (typically a few hundred to a few\n    thousand quote rows), so instead of streaming incremental diffs we re-run the\n    user\'s EXACT pandas algorithm over the whole window on every change, in the\n    sheet\'s own row order — byte-for-byte what running process_taq.py on the file\n    at that moment would produce:\n\n        side (PRCTCK_1): map QUALIFIERS → ffill().bfill()   (in FILE order)\n        SEQNUM:          diff().abs().shift(-1).fillna(0)   (in FILE order)\n        RTL:             d = diff().abs().shift(-1);\n                         np.where(d >= 60000, ORIGINAL RTL, d); fillna(0)\n\n    On a DESC sheet (newest rows at the top — the Refinitiv default) this means a\n    tick\'s diff is against the PREVIOUS tick in time, so a new tick\'s values are\n    final the moment it arrives: no delay, and already-emitted rows never change.\n\n    Emission stability: a row whose side came only from bfill() (no sided row\n    ABOVE it in the file yet) would flip side once a newer sided tick arrives, so\n    such rows are HELD until their side is stable; everything else emits at once.\n    """\n\n    def __init__(self, source_path: str):\n        self.source_path = source_path\n        folder = os.path.dirname(source_path)\n        stem = Path(source_path).stem\n        self.cleaned_path = os.path.join(folder, f"{stem}_taq_cleaned.xlsx")\n        self._cleaned_rows: list[dict] = []\n        self.spl_trd = 0.0  # TAQ has no SPL TRD — kept for message compatibility\n        self._seen_keys: set[str] = set()\n        self._amended: list[dict] = []  # kept for poll-loop API compatibility\n\n    def reset(self):\n        self._cleaned_rows.clear()\n        self.spl_trd = 0.0\n        self._seen_keys.clear()\n        self._amended = []\n\n    # ── The user\'s convert_qualifiers(), verbatim semantics ──────────────────\n    @staticmethod\n    def _convert(df: pd.DataFrame) -> pd.DataFrame:\n        df = df.copy()\n        for col in ["SEQNUM", "RTL", "QUALIFIERS", "PRCTCK_1"]:\n            if col not in df.columns:\n                df[col] = np.nan\n        df["QUALIFIERS"] = df["QUALIFIERS"].astype(str).str.strip()\n        df["SEQNUM"] = pd.to_numeric(df["SEQNUM"], errors="coerce")\n        df["RTL"] = pd.to_numeric(df["RTL"], errors="coerce")\n\n        rtl_orig = df["RTL"].copy()\n        df["SEQNUM"] = df["SEQNUM"].diff().abs().shift(-1).fillna(0)\n        diff_rtl = df["RTL"].diff().abs().shift(-1)\n        df["RTL"] = pd.Series(np.where(diff_rtl >= 60000, rtl_orig, diff_rtl), index=df.index)\n        df["RTL"] = pd.to_numeric(df["RTL"], errors="coerce").fillna(0)\n\n        raw_side = df["QUALIFIERS"].apply(_taq_side)          # ⇧ / ⇩ / None\n        df["_side_raw"] = raw_side\n        # Side stability: ffill has a source once ANY sided row exists above.\n        df["_side_stable"] = raw_side.notna().cummax()\n        temp = raw_side.ffill().bfill()\n        if "PRCTCK_1" in df.columns:\n            df.drop(columns=["PRCTCK_1"], inplace=True)\n        df.insert(1, "PRCTCK_1", temp)\n        return df\n\n    def process_window(self, df_raw: pd.DataFrame, *, reset: bool = False) -> tuple[list[dict], float]:\n        """Recompute the whole window (sheet order) and return NEW stable rows in\n        chronological order. Idempotent across polls via the seen-key set."""\n        if reset:\n            self.reset()\n        if df_raw is None or df_raw.empty:\n            return [], self.spl_trd\n\n        df = df_raw.copy()\n        df.columns = df.columns.astype(str).str.strip()\n        for c in REQUIRED_COLS + OPTIONAL_COLS:\n            if c not in df.columns:\n                df[c] = np.nan\n        df[REQUIRED_COLS] = df[REQUIRED_COLS].replace(["", "nan", "NaN", None], np.nan)\n        for c in ["BID", "ASK", "BIDSIZE", "ASKSIZE"]:\n            df[c] = pd.to_numeric(df[c], errors="coerce")\n        df[["BID", "ASK"]] = df[["BID", "ASK"]].ffill().bfill()\n        df["BIDSIZE"] = df["BIDSIZE"].fillna(0)\n        df["ASKSIZE"] = df["ASKSIZE"].fillna(0)\n\n        seq_raw_col = pd.to_numeric(df["SEQNUM"], errors="coerce")  # raw, pre-diff\n        rtl_raw_col = pd.to_numeric(df["RTL"], errors="coerce")\n\n        conv = self._convert(df)\n\n        # Detect sheet order to emit chronologically (oldest → newest).\n        ts_col = next((c for c in ("Timestamp", "TIMESTAMP") if c in df.columns), None)\n        order_desc = True\n        if ts_col is not None:\n            try:\n                import warnings\n                with warnings.catch_warnings():\n                    warnings.simplefilter("ignore")\n                    tsv = pd.to_datetime(conv[ts_col].astype(str).str.replace(\n                        r"(\\d{1,2}:\\d{2}:\\d{2}):(\\d{1,4})\\s*$", r"\\1.\\2", regex=True),\n                        errors="coerce", dayfirst=True)\n                first = tsv.dropna().iloc[0] if tsv.notna().any() else None\n                last = tsv.dropna().iloc[-1] if tsv.notna().any() else None\n                if first is not None and last is not None and first != last:\n                    order_desc = first > last\n            except Exception:\n                pass\n\n        idx_iter = list(range(len(conv) - 1, -1, -1)) if order_desc else list(range(len(conv)))\n\n        rows: list[dict] = []\n        for i in idx_iter:\n            side = conv["PRCTCK_1"].iloc[i]\n            if side not in ("⇧", "⇩"):\n                continue\n            stable = bool(conv["_side_stable"].iloc[i]) or (conv["_side_raw"].iloc[i] in ("⇧", "⇩"))\n            if not stable:\n                continue  # held until a newer sided tick fixes its ffill source\n\n            bid = safe_num(conv["BID"].iloc[i])\n            ask = safe_num(conv["ASK"].iloc[i])\n            last = bid if side == "⇧" else ask\n            if last <= 0:\n                continue\n            # ⇧ = LIFT (ASK aggressor / buyer at the ask), ⇩ = HIT (BID aggressor /\n            # seller at the bid) — matches the TAQ column definitions and the chart.\n            aggr = "ASK" if side == "⇧" else "BID"\n            b_size = safe_num(conv["BIDSIZE"].iloc[i])\n            a_size = safe_num(conv["ASKSIZE"].iloc[i])\n            seq_raw = seq_raw_col.iloc[i]\n            rtl_raw = rtl_raw_col.iloc[i]\n            seq_diff = safe_num(conv["SEQNUM"].iloc[i])\n            rtl_diff = safe_num(conv["RTL"].iloc[i])\n            qual = safe_str(conv["QUALIFIERS"].iloc[i])\n            trade_key = str(int(seq_raw)) if pd.notna(seq_raw) and seq_raw else ""\n\n            ts_val = conv[ts_col].iloc[i] if ts_col else None\n            time_str, date_str = parse_timestamp(ts_val, None, None)\n\n            dedup_key = (f"id:{trade_key}|t:{time_str}|p:{last}"\n                         if trade_key else\n                         f"t:{time_str}|p:{last}|b:{bid}|a:{ask}|bs:{b_size}|as:{a_size}|r:{rtl_raw}")\n            if dedup_key in self._seen_keys:\n                continue\n            self._seen_keys.add(dedup_key)\n\n            row = {\n                "last": last,\n                "bid": bid,\n                "ask": ask,\n                "bSize": b_size,\n                "aSize": a_size,\n                "trdVol": 0.0,          # TAQ source has no trade-volume column\n                "volume": 0.0,\n                "aggr": aggr,\n                "tick": side,\n                "tradeId": trade_key,\n                "seqNum": safe_num(seq_raw),\n                "moves": safe_num(rtl_raw),\n                "rtCount": safe_num(rtl_raw),\n                "trdIdDiff": seq_diff,   # TAQ has no TRADE_ID — SEQ diff is the proxy\n                "seqNumDiff": seq_diff,\n                "movesDiff": rtl_diff,\n                "volDiff": 0.0,\n                "condKey": qual,\n                "QUALIFIERS": qual,\n                "time": time_str,\n                "date": date_str,\n            }\n            rows.append(row)\n            self._cleaned_rows.append(row)\n\n        return rows, self.spl_trd\n\n    # Back-compat alias used by read_rows_for\n    def process_chunk(self, df_raw: pd.DataFrame, *, reset: bool = False) -> tuple[list[dict], float]:\n        return self.process_window(df_raw, reset=reset)\n\n    def pop_amended(self) -> list[dict]:\n        out, self._amended = self._amended, []\n        return out\n\n    def flush_pending(self) -> dict | None:\n        return None  # whole-window recompute has no pending row\n\n    def save_cleaned(self) -> str | None:\n        if not self._cleaned_rows:\n            log.warning("No cleaned rows to save yet.")\n            return None\n        try:\n            pd.DataFrame(self._cleaned_rows).to_excel(self.cleaned_path, index=False)\n            log.info("Saved: %s", self.cleaned_path)\n            return self.cleaned_path\n        except Exception as exc:\n            log.error("Save failed: %s", exc)\n            return None\n\n\nclass FileState:\n    def __init__(self, path: str):\n        self.path = path\n        raw_name = os.path.basename(path)\n        self.name = raw_name[2:] if raw_name.startswith("~$") else raw_name\n        self.processor = TaqProcessor(path)\n        self.known_ids: set[str] = set()\n        self.all_rows: list[dict] = []\n        self.last_spl_trd = 0.0\n        self._wb_ref: Any = None\n        self._sheet_ref: Any = None\n        self._hdr_cache: list[str] | None = None\n        self._last_col = 0\n        self._last_excel_row = DATA_START_ROW - 1  # last ACTIVE data row (not used_range)\n        self._calc_cycle = 0\n        self._com_fails = 0\n        self._last_tail_signature: str = ""\n        self._order: str = "asc"  # auto-detected each poll: \'asc\' | \'desc\'\n        self.pending_amends: list[dict] = []\n\n    def reset_data(self):\n        self.known_ids.clear()\n        self.all_rows.clear()\n        self.last_spl_trd = 0.0\n        self._last_excel_row = DATA_START_ROW - 1\n        self._last_tail_signature = ""\n        self.pending_amends.clear()\n        self.processor.reset()\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# Excel helpers\n# ─────────────────────────────────────────────────────────────────────────────\ndef _clean_path(raw: str) -> str:\n    p = Path(raw).resolve()\n    if p.name.startswith("~$"):\n        real = p.parent / p.name[2:]\n        if real.exists():\n            return str(real)\n    return str(p)\n\n\ndef _col_letter(n: int) -> str:\n    s = ""\n    while n:\n        n, rem = divmod(n - 1, 26)\n        s = chr(65 + rem) + s\n    return s\n\n\ndef _find_workbook(path: str):\n    try:\n        books = list(xw.books)\n    except Exception:\n        return None\n    target = os.path.basename(path).lower().lstrip("~$")\n    for book in books:\n        try:\n            full = str(book.fullname)\n            bn = os.path.basename(full).lower().lstrip("~$")\n            if bn == target or full.lower() == path.lower():\n                return book\n        except Exception:\n            continue\n    real = []\n    for book in books:\n        try:\n            name = os.path.basename(str(book.fullname))\n            if not name.startswith("~$") and not name.startswith("Book"):\n                real.append(book)\n        except Exception:\n            pass\n    return real[0] if len(real) == 1 else None\n\n\ndef _validate_wb(wb: Any) -> bool:\n    try:\n        _ = wb.name\n        return True\n    except Exception:\n        return False\n\n\ndef _row_key(r: dict) -> str:\n    tid = safe_str(r.get("tradeId"))\n    if tid and tid not in ("0", "0.0", "nan"):\n        return f"id:{tid}|t:{r.get(\'time\',\'\')}|p:{r.get(\'last\',0)}"\n    seq = safe_num(r.get("seqNum"))\n    if seq:\n        return f"seq:{int(seq)}|t:{r.get(\'time\',\'\')}|p:{r.get(\'last\',0)}"\n    return f"t:{r.get(\'time\',\'\')}|p:{r.get(\'last\',0)}|b:{r.get(\'bid\',0)}|a:{r.get(\'ask\',0)}|v:{r.get(\'trdVol\',0)}"\n\n\ndef _get_workbook_and_sheet(state: FileState):\n    wb = state._wb_ref\n    if wb is not None and not _validate_wb(wb):\n        state._wb_ref = None\n        state._sheet_ref = None\n        state._hdr_cache = None\n        wb = None\n    if wb is None:\n        wb = _find_workbook(state.path)\n        if wb is None:\n            return None, None\n        state._wb_ref = wb\n        state._sheet_ref = None\n        state._hdr_cache = None\n    if state._sheet_ref is None:\n        try:\n            state._sheet_ref = wb.sheets[0]\n        except Exception:\n            state._wb_ref = None\n            state._sheet_ref = None\n            return None, None\n    return wb, state._sheet_ref\n\n\ndef _read_headers_if_needed(state: FileState, sheet: Any, last_col: int) -> list[str] | None:\n    if state._hdr_cache is not None and state._last_col == last_col:\n        return state._hdr_cache\n    end_col = _col_letter(last_col)\n    try:\n        raw = sheet.range(f"A{HEADER_ROW}:{end_col}{HEADER_ROW}").value or []\n    except Exception:\n        state._hdr_cache = None\n        return None\n    if not isinstance(raw, list):\n        raw = [raw]\n    headers = [str(h).strip() if h is not None else "" for h in raw]\n    state._hdr_cache = headers\n    state._last_col = last_col\n    return headers\n\n\ndef _make_df(data: Any, headers: list[str]) -> pd.DataFrame:\n    if data is None:\n        return pd.DataFrame(columns=headers)\n    if data and not isinstance(data[0], list):\n        data = [data]\n    rows = [r for r in data if r and any(c is not None for c in r)]\n    if not rows:\n        return pd.DataFrame(columns=headers)\n    fixed = []\n    n = len(headers)\n    for r in rows:\n        if len(r) < n:\n            r = list(r) + [None] * (n - len(r))\n        elif len(r) > n:\n            r = list(r)[:n]\n        fixed.append(r)\n    return pd.DataFrame(fixed, columns=headers)\n\n\ndef _raw_signature(data: Any, last_n: int = 8, *, head: bool = False) -> str:\n    """Small signature of the changing edge of the Excel table.\n    Refinitiv live functions often update rows in-place or shift a fixed RET range,\n    so last_row does not always increase. This signature lets us detect those\n    in-place changes and still broadcast new rows. For DESC tables (newest rows at\n    the top) the changing edge is the HEAD of the window instead of the tail.\n    """\n    if data is None:\n        return ""\n    try:\n        rows = data if isinstance(data, list) else [data]\n        if rows and not isinstance(rows[0], list):\n            rows = [rows]\n        edge = rows[:last_n] if head else rows[-last_n:]\n        return repr(edge)\n    except Exception:\n        return repr(data)\n\n\ndef _detect_order(ts_values: list) -> str | None:\n    """Detect whether the timestamp column runs oldest→newest (\'asc\') or\n    newest→oldest (\'desc\'). Returns None when undecidable (e.g. all equal)."""\n    vals = [v for v in ts_values if v is not None and str(v).strip() != ""]\n    if len(vals) < 2:\n        return None\n\n    def _norm(v):\n        # Refinitiv timestamps often end in ":mmm" (e.g. "13-jul-26 10:00:10:010"),\n        # which pandas can\'t parse — convert the final colon to a decimal point.\n        s = str(v).strip()\n        return re.sub(r\'(\\d{1,2}:\\d{2}:\\d{2}):(\\d{1,4})\\s*$\', r\'\\1.\\2\', s)\n\n    vals = [v if isinstance(v, (datetime, pd.Timestamp)) else _norm(v) for v in vals]\n    try:\n        import warnings\n        with warnings.catch_warnings():\n            warnings.simplefilter("ignore")\n            s = pd.to_datetime(pd.Series([vals[0], vals[-1]]), errors="coerce", dayfirst=True)\n            a, b = s.iloc[0], s.iloc[1]\n            if pd.notna(a) and pd.notna(b) and a != b:\n                return "asc" if a < b else "desc"\n            # Endpoints equal/unparseable → look at the full sample.\n            s2 = pd.to_datetime(pd.Series(vals), errors="coerce", dayfirst=True).dropna()\n        if len(s2) < 2 or s2.nunique() < 2:\n            return None\n        if s2.is_monotonic_increasing:\n            return "asc"\n        if s2.is_monotonic_decreasing:\n            return "desc"\n        # Mixed/noisy: compare first vs last valid stamps.\n        return "asc" if s2.iloc[0] <= s2.iloc[-1] else "desc"\n    except Exception:\n        return None\n\n\ndef _active_extent(ts_values: list) -> int | None:\n    """Index (0-based within the read column) of the last row that actually has a\n    timestamp. Fixed RFV windows pre-allocate the block, so used_range covers far\n    more rows than the data that has arrived; scanning from used_range\'s bottom\n    would only ever see blank padding."""\n    for i in range(len(ts_values) - 1, -1, -1):\n        v = ts_values[i]\n        if v is not None and str(v).strip() != "":\n            return i\n    return None\n\n\ndef read_rows_for(state: FileState, *, seed: bool = False) -> list[dict] | None:\n    wb, sheet = _get_workbook_and_sheet(state)\n    if wb is None or sheet is None:\n        return None\n\n    if CALC_EVERY_N and CALC_EVERY_N > 0:\n        state._calc_cycle = (state._calc_cycle + 1) % CALC_EVERY_N\n        if state._calc_cycle == 0:\n            try:\n                wb.app.calculate()\n            except Exception:\n                pass\n\n    try:\n        used = sheet.used_range\n        last_col = int(used.last_cell.column)\n        last_row = int(used.last_cell.row)\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n\n    if last_row < DATA_START_ROW:\n        return []\n\n    headers = _read_headers_if_needed(state, sheet, last_col)\n    if not headers:\n        return []\n\n    end_col = _col_letter(last_col)\n\n    # Locate the ACTIVE data extent from the timestamp column. Fixed RFV windows\n    # (START..END) pre-allocate the whole block and fill it in-place, so\n    # used_range\'s last row stays constant and its bottom rows are blank padding —\n    # scanning there sees no change and the app freezes at the seed snapshot.\n    try:\n        ts_raw = sheet.range(f"A{DATA_START_ROW}:A{last_row}").value\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n    if not isinstance(ts_raw, list):\n        ts_raw = [ts_raw]\n    ext = _active_extent(ts_raw)\n    if ext is None:\n        return []\n    active_last = DATA_START_ROW + ext\n\n    # Auto-detect row ordering (ASC: newest appended at the bottom;\n    # DESC: newest inserted at the top). Sticky when undecidable. Informational —\n    # the whole-window processor works in the sheet\'s own order either way.\n    order = _detect_order(ts_raw[: ext + 1]) or state._order\n    if order != state._order:\n        log.info("[%s] Detected %s row order", state.name, order.upper())\n        state._order = order\n\n    if active_last < state._last_excel_row and FULL_RESEED_ON_ROW_DROP:\n        log.info("[%s] Active data extent dropped; reseeding snapshot", state.name)\n        state.reset_data()\n\n    # WHOLE-WINDOW strategy: TAQ sheets are small fixed RFV windows, so on any\n    # change we re-read the entire active extent and re-run process_taq.py\'s\n    # algorithm over it — new rows fall out via the processor\'s dedup. A change\n    # is detected on either edge (DESC updates the head, ASC the tail).\n    start_row, end_row = DATA_START_ROW, active_last\n    reset_processor = bool(seed or state._last_excel_row < DATA_START_ROW)\n\n    try:\n        head_sig = repr(sheet.range(f"A{DATA_START_ROW}:{end_col}{min(DATA_START_ROW + 7, active_last)}").value)\n        tail_sig = repr(sheet.range(f"A{max(DATA_START_ROW, active_last - 7)}:{end_col}{active_last}").value)\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n    sig = f"{active_last}|{head_sig}|{tail_sig}"\n    if not reset_processor and sig == state._last_tail_signature:\n        state._last_excel_row = active_last\n        return []\n    state._last_tail_signature = sig\n    state._last_excel_row = active_last\n\n    try:\n        data = sheet.range(f"A{start_row}:{end_col}{end_row}").value\n    except Exception:\n        state._wb_ref = None\n        state._sheet_ref = None\n        return None\n\n    df = _make_df(data, headers)\n    if df.empty:\n        return []\n\n    try:\n        rows, spl_trd = state.processor.process_chunk(df, reset=reset_processor)\n    except Exception as exc:\n        log.error("[%s] process_chunk failed: %s", state.name, exc, exc_info=True)\n        return []\n\n    state.last_spl_trd = spl_trd\n    # Rows finalized after emission (their exact forward diffs are now known);\n    # staged for an \'amend\' broadcast so connected clients converge to exact values.\n    state.pending_amends.extend(state.processor.pop_amended())\n    new_rows = []\n    for r in rows:\n        k = _row_key(r)\n        if k in state.known_ids:\n            continue\n        state.known_ids.add(k)\n        state.all_rows.append(r)\n        new_rows.append(r)\n    return new_rows\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# WebSocket server\n# ─────────────────────────────────────────────────────────────────────────────\nasync def _send(ws: Any, obj: Any):\n    try:\n        await ws.send(safe_json(obj))\n    except Exception:\n        pass\n\n\nasync def _broadcast(obj: Any):\n    if not _clients:\n        return\n    msg = safe_json(obj)\n    dead = set()\n    for ws in list(_clients):\n        try:\n            await ws.send(msg)\n        except Exception:\n            dead.add(ws)\n    _clients.difference_update(dead)\n\n\nasync def _ws_handler(ws: Any, path: str | None = None):\n    _clients.add(ws)\n    remote = getattr(ws, "remote_address", "?")\n    log.info("Client connected: %s total=%d", remote, len(_clients))\n    try:\n        await _send(ws, {\n            "type": "connected",\n            "server": "xlwings-bridge-tas",\n            "version": "8.1-taq-fwd-diff-active-extent",\n            "files": [s.name for s in _file_states.values()],\n            "file": ", ".join(s.name for s in _file_states.values()),\n        })\n        for state in _file_states.values():\n            if state.all_rows:\n                await _send(ws, {\n                    "type": "snapshot",\n                    "file": state.name,\n                    "rows": state.all_rows,\n                    "total": len(state.all_rows),\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                    "splTrd": state.last_spl_trd,\n                })\n        async for raw in ws:\n            try:\n                msg = json.loads(raw)\n                cmd = msg.get("type") or msg.get("cmd")\n                if cmd == "ping":\n                    await _send(ws, {"type": "pong", "ts": datetime.now().strftime("%H:%M:%S")})\n                elif cmd == "save":\n                    results = {s.name: s.processor.save_cleaned() for s in _file_states.values()}\n                    await _send(ws, {"type": "saved", "ok": any(results.values()), "files": results})\n                elif cmd == "resync":\n                    for s in _file_states.values():\n                        s.reset_data()\n                        read_rows_for(s, seed=True)\n                    await _send(ws, {"type": "resynced", "ok": True})\n            except Exception:\n                continue\n    except Exception:\n        pass\n    finally:\n        _clients.discard(ws)\n        log.info("Client disconnected: %s", remote)\n\n\nasync def _poll_loop():\n    cycle = 0\n    warned: set[str] = set()\n    log.info("Polling %d file(s) every %.2fs", len(_file_states), CHECK_INTERVAL)\n    while True:\n        await asyncio.sleep(CHECK_INTERVAL)\n        cycle += 1\n        for path, state in _file_states.items():\n            try:\n                new_rows = read_rows_for(state)\n            except COM_ERR as exc:\n                state._com_fails += 1\n                state._wb_ref = None\n                state._sheet_ref = None\n                if state._com_fails <= 3 or state._com_fails % 20 == 0:\n                    log.warning("[%s] Excel busy x%d: %s", state.name, state._com_fails, str(exc)[:90])\n                continue\n            except Exception as exc:\n                state._wb_ref = None\n                state._sheet_ref = None\n                log.error("[%s] Poll error: %s", state.name, exc, exc_info=True)\n                continue\n\n            if new_rows is None:\n                if path not in warned or cycle % 40 == 0:\n                    log.warning("[%s] Not open in Excel yet — waiting…", state.name)\n                    warned.add(path)\n                continue\n\n            if state._com_fails:\n                log.info("[%s] Excel COM recovered after %d failures", state.name, state._com_fails)\n                state._com_fails = 0\n            warned.discard(path)\n\n            if new_rows:\n                await _broadcast({\n                    "type": "ticks",\n                    "file": state.name,\n                    "rows": new_rows,\n                    "total": len(state.all_rows),\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                    "splTrd": state.last_spl_trd,\n                })\n                log.info("Cycle %5d [%s] +%d rows total=%d splTrd=%.0f",\n                         cycle, state.name, len(new_rows), len(state.all_rows), state.last_spl_trd)\n\n            if state.pending_amends:\n                amends, state.pending_amends = state.pending_amends, []\n                await _broadcast({\n                    "type": "amend",\n                    "file": state.name,\n                    "rows": [{"key": _row_key(r),\n                              "tradeId": r.get("tradeId"), "time": r.get("time"),\n                              "last": r.get("last"),\n                              "trdIdDiff": r.get("trdIdDiff"),\n                              "seqNumDiff": r.get("seqNumDiff"),\n                              "movesDiff": r.get("movesDiff")} for r in amends],\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                })\n\n        if cycle % max(1, int(5 / max(CHECK_INTERVAL, 0.05))) == 0:\n            await _broadcast({\n                "type": "heartbeat",\n                "files": {p: {"name": s.name, "rows": len(s.all_rows), "splTrd": s.last_spl_trd}\n                          for p, s in _file_states.items()},\n                "clients": len(_clients),\n                "ts": datetime.now().strftime("%H:%M:%S"),\n            })\n\n\nasync def _start_server():\n    kwargs = {\n        "ping_interval": 30,\n        "ping_timeout": 10,\n        "close_timeout": 5,\n        "max_size": MAX_WS_SIZE,\n    }\n    if WS_VERSION >= (14, 0):\n        async def handler_v14(ws):\n            await _ws_handler(ws)\n        async with websockets.serve(handler_v14, WS_HOST, WS_PORT, **kwargs):\n            log.info("ws://%s:%d ready", WS_HOST, WS_PORT)\n            await _poll_loop()\n    else:\n        try:\n            from websockets.server import serve as ws_serve\n        except Exception:\n            from websockets import serve as ws_serve\n        async with ws_serve(_ws_handler, WS_HOST, WS_PORT, **kwargs):\n            log.info("ws://%s:%d ready", WS_HOST, WS_PORT)\n            await _poll_loop()\n\n\n# ─────────────────────────────────────────────────────────────────────────────\n# File picker / main\n# ─────────────────────────────────────────────────────────────────────────────\ndef select_files(cli_files: list[str]) -> list[str]:\n    if cli_files:\n        paths = [_clean_path(p) for p in cli_files]\n        missing = [p for p in paths if not Path(p).exists()]\n        if missing:\n            log.error("Not found: %s", missing)\n            sys.exit(1)\n        return paths\n    try:\n        import tkinter as tk\n        from tkinter import filedialog\n        root = tk.Tk()\n        root.withdraw()\n        chosen = filedialog.askopenfilenames(\n            title="Select TAS Excel file",\n            filetypes=[("Excel", "*.xlsx *.xlsm *.xls"), ("CSV", "*.csv"), ("All", "*.*")],\n        )\n        root.destroy()\n        if not chosen:\n            sys.exit(0)\n        return [_clean_path(p) for p in chosen]\n    except Exception as exc:\n        log.error("File picker failed: %s", exc)\n        sys.exit(1)\n\n\nasync def _main():\n    global WS_PORT, CHECK_INTERVAL, HEADER_ROW, DATA_START_ROW, CALC_EVERY_N\n    parser = argparse.ArgumentParser(description="Optimized xlwings WebSocket bridge for TAS HTML")\n    parser.add_argument("files", nargs="*", help="Excel TAS file(s)")\n    parser.add_argument("--port", type=int, default=8766)\n    parser.add_argument("--interval", type=float, default=0.25, help="Poll interval seconds; try 0.25 or 0.3")\n    parser.add_argument("--header-row", type=int, default=3)\n    parser.add_argument("--data-row", type=int, default=4)\n    parser.add_argument("--calc-every", type=int, default=0, help="Force Excel calculate every N polls; 0 disables")\n    args = parser.parse_args()\n\n    WS_PORT = args.port\n    CHECK_INTERVAL = max(0.05, args.interval)\n    HEADER_ROW = args.header_row\n    DATA_START_ROW = args.data_row\n    CALC_EVERY_N = max(0, args.calc_every)\n\n    files = select_files(args.files)\n    log.info("=" * 70)\n    log.info("OrderFlow Trader TAS — xlwings Bridge v8 live tail scan")\n    log.info("Reads appended rows + scans live tail for in-place Refinitiv updates. WebSocket: ws://%s:%d", WS_HOST, WS_PORT)\n    log.info("Poll interval: %.2fs | header row: %d | data row: %d | calc_every: %d",\n             CHECK_INTERVAL, HEADER_ROW, DATA_START_ROW, CALC_EVERY_N)\n    log.info("Files: %s", ", ".join(files))\n    log.info("Python: %s | websockets: %s", sys.version.split()[0], websockets.__version__)\n    log.info("=" * 70)\n\n    for p in files:\n        st = FileState(p)\n        _file_states[p] = st\n        wb = _find_workbook(p)\n        if wb is None:\n            log.warning("[%s] Not open in Excel yet — will wait", st.name)\n            continue\n        st._wb_ref = wb\n        log.info("[%s] Found workbook: %s", st.name, wb.fullname)\n        seed = read_rows_for(st, seed=True)\n        if seed:\n            log.info("[%s] Seeded %d rows", st.name, len(st.all_rows))\n\n    await _start_server()\n\n\nif __name__ == "__main__":\n    try:\n        asyncio.run(_main())\n    except KeyboardInterrupt:\n        log.info("Bridge stopped.")\n'
_CF_SOURCE  = '\n"""\nxlwings_orderflow_cf_manual_picker.py\n\nWebSocket bridge for OrderFlow HTML using Refinitiv / CF Excel format.\n\nInstall:\n    py -m pip install xlwings pandas numpy openpyxl websockets\n\nRun:\n    python -u xlwings_orderflow_cf_manual_picker.py --interval 0.05\n\nThis version:\n- Opens a file picker so you choose the exact Excel workbook.\n- Connects only to that selected workbook if it is open in Excel.\n- Auto-detects the real header row.\n- Builds Timestamp from:\n    Timestamp\n    or ACTIVE DATE / Date of Update + TIMEACT NS / IMPACT NS / Time\n- Cleans NaN values.\n- Removes duplicates.\n- Sends #Trades as the DIFFERENCE of NUMBER TRADES, not the full accumulated value.\n- Sends Trade ID as the DIFFERENCE of TRADE_ID, not the full accumulated value.\n"""\n\nfrom __future__ import annotations\n\nimport argparse\nimport asyncio\nimport json\nimport logging\nimport math\nimport re\nfrom datetime import datetime, date, time\nfrom pathlib import Path\nimport tkinter as tk\nfrom tkinter import filedialog\n\nimport numpy as np\nimport pandas as pd\nimport xlwings as xw\nimport websockets\n\n\nWS_HOST = "localhost"\nWS_PORT = 8766\nPOLL_INTERVAL = 0.05\nAUTO_HEADER_SCAN_ROWS = 25\nMAX_READ_COLS = 100\n\n_clients = set()\nFILE_STATES = []\n\nlogging.basicConfig(\n    level=logging.INFO,\n    format="%(asctime)s  %(levelname)-8s  %(message)s",\n    datefmt="%H:%M:%S"\n)\nlog = logging.getLogger("orderflow-xlwings")\n\n\ndef safe_num(v, default=0.0):\n    if v is None:\n        return default\n    try:\n        if isinstance(v, str):\n            v = v.strip().replace(" ", "").replace(",", ".")\n            if v == "":\n                return default\n        f = float(v)\n        return default if math.isnan(f) or math.isinf(f) else f\n    except Exception:\n        return default\n\n\ndef safe_str(v, default=""):\n    if v is None:\n        return default\n    s = str(v).strip()\n    return default if s.lower() in ("", "nan", "none", "nat") else s\n\n\ndef clean_header(h):\n    return re.sub(r"\\s+", " ", safe_str(h)).strip()\n\n\ndef norm_key(s):\n    return re.sub(r"[^A-Z0-9]+", "", safe_str(s).upper())\n\n\ndef find_col(df, candidates):\n    lookup = {norm_key(c): c for c in df.columns}\n    for cand in candidates:\n        k = norm_key(cand)\n        if k in lookup:\n            return lookup[k]\n    return None\n\n\ndef fillna_with_last_digits(original, processed, digits=2):\n    fallback = original.astype(str).str.extract(r"(\\d+)$")[0].str[-digits:]\n    fallback = pd.to_numeric(fallback, errors="coerce")\n    return processed.fillna(fallback).fillna(0)\n\n\ndef choose_excel_file():\n    root = tk.Tk()\n    root.withdraw()\n    root.attributes("-topmost", True)\n    file_path = filedialog.askopenfilename(\n        title="Select the OPEN Excel workbook to connect",\n        filetypes=[("Excel Files", "*.xlsm *.xlsx *.xls"), ("All Files", "*.*")]\n    )\n    root.destroy()\n    if not file_path:\n        raise SystemExit("No Excel file selected.")\n    return str(Path(file_path).resolve())\n\n\ndef safe_json(obj):\n    def clean(o):\n        if isinstance(o, float):\n            return 0 if math.isnan(o) or math.isinf(o) else o\n        if isinstance(o, dict):\n            return {k: clean(v) for k, v in o.items()}\n        if isinstance(o, list):\n            return [clean(v) for v in o]\n        if hasattr(o, "item"):\n            try:\n                return clean(o.item())\n            except Exception:\n                pass\n        return o\n    return json.dumps(clean(obj), ensure_ascii=False)\n\n\nDATE_CANDIDATES = ["ACTIVE DATE", "Date of Update", "Date", "DATE"]\nTIME_CANDIDATES = ["TIMEACT NS", "IMPACT NS", "TIMEACT", "Time", "TIME"]\nTIMESTAMP_CANDIDATES = ["Timestamp", "TIMESTAMP", "DateTime", "DATE TIME"]\n\n\ndef normalize_date_value(v):\n    if v is None:\n        return None\n    if isinstance(v, (pd.Timestamp, datetime)):\n        return v.strftime("%Y-%m-%d")\n    if isinstance(v, date):\n        return v.strftime("%Y-%m-%d")\n    if isinstance(v, (int, float)) and v > 20000:\n        try:\n            return pd.to_datetime(v, unit="D", origin="1899-12-30").strftime("%Y-%m-%d")\n        except Exception:\n            pass\n    s = safe_str(v)\n    if not s:\n        return None\n    dt = pd.to_datetime(s, dayfirst=True, errors="coerce")\n    if pd.notna(dt):\n        return dt.strftime("%Y-%m-%d")\n    dt = pd.to_datetime(s, dayfirst=False, errors="coerce")\n    if pd.notna(dt):\n        return dt.strftime("%Y-%m-%d")\n    return None\n\n\ndef normalize_time_value(v):\n    if v is None:\n        return None\n    if isinstance(v, (pd.Timestamp, datetime)):\n        return v.strftime("%H:%M:%S")\n    if isinstance(v, time):\n        return v.strftime("%H:%M:%S")\n    if isinstance(v, (int, float)) and 0 <= float(v) < 1:\n        secs = int(round(float(v) * 86400)) % 86400\n        h, rem = divmod(secs, 3600)\n        m, s = divmod(rem, 60)\n        return f"{h:02d}:{m:02d}:{s:02d}"\n    s = safe_str(v)\n    m = re.search(r"(\\d{1,2}):(\\d{2})(?::(\\d{2}))?", s)\n    if m:\n        return f"{int(m.group(1)):02d}:{int(m.group(2)):02d}:{int(m.group(3) or 0):02d}"\n    return None\n\n\ndef build_timestamp(df):\n    df = df.copy()\n\n    ts_col = find_col(df, TIMESTAMP_CANDIDATES)\n    if ts_col:\n        parsed = pd.to_datetime(df[ts_col], dayfirst=True, errors="coerce")\n        if parsed.notna().sum() == 0:\n            parsed = pd.to_datetime(df[ts_col], dayfirst=False, errors="coerce")\n        df["Timestamp"] = parsed.dt.strftime("%Y-%m-%d %H:%M:%S")\n        return df\n\n    date_col = find_col(df, DATE_CANDIDATES)\n    time_col = find_col(df, TIME_CANDIDATES)\n\n    if date_col is None or time_col is None:\n        log.warning("Could not build Timestamp. Columns: %s", list(df.columns))\n        df["Timestamp"] = np.nan\n        return df\n\n    date_str = df[date_col].apply(normalize_date_value)\n    time_str = df[time_col].apply(normalize_time_value)\n    parsed = pd.to_datetime(\n        date_str.fillna("") + " " + time_str.fillna(""),\n        format="%Y-%m-%d %H:%M:%S",\n        errors="coerce"\n    )\n    df["Timestamp"] = parsed.dt.strftime("%Y-%m-%d %H:%M:%S")\n    return df\n\n\nclass CFProcessor:\n    def __init__(self):\n        self.cleaned_df = None\n\n    def process(self, df_raw):\n        df = self.clean_dataframe(df_raw)\n        self.cleaned_df = df.copy()\n        return self.to_html_rows(df)\n\n    def clean_dataframe(self, df_raw):\n        df = df_raw.copy()\n        df.columns = [clean_header(c) for c in df.columns]\n        df = df.loc[:, [c for c in df.columns if c != ""]]\n        df = build_timestamp(df)\n        df = df[df["Timestamp"].notna()].copy()\n\n        col_tick = find_col(df, ["CF TICK", "PRCTCK_1", "Tick"])\n        col_aggr = find_col(df, ["AGGRESSIVE ORD1", "AGGRS_SID1", "Aggressive", "AGGRESS"])\n        col_last = find_col(df, ["LAST", "TRDPRC_1", "Last"])\n        col_bid = find_col(df, ["CF BID", "BID", "Bid"])\n        col_ask = find_col(df, ["CF ASK", "ASK", "Ask"])\n        col_bsize = find_col(df, ["BID SIZE", "BIDSIZE", "B Size"])\n        col_asize = find_col(df, ["ASK SIZE", "ASKSIZE", "A Size"])\n        col_numbo = find_col(df, ["NUM BID ORDERS 1", "NO_BIDORD1"])\n        col_numao = find_col(df, ["NUM ASK ORDERS 1", "NO_ASKORD1"])\n        col_nord = find_col(df, ["NUMBER OF ORDERS", "NO_ORD"])\n        col_trdvol = find_col(df, ["TRADE VOL", "TRDVOL_1", "Trade Vol"])\n        col_cfvol = find_col(df, ["CF VOLUME", "Volume", "CF_VOLUME"])\n        col_acvol = find_col(df, ["ELIGBL TRD ACVOL", "RTL", "ELG_ACVOL"])\n        col_ntrd = find_col(df, ["NUMBER TRADES", "NUMBER OF TRADES", "NUM_MOVES", "Moves"])\n        col_tid = find_col(df, ["TRADE_ID", "TRADE ID", "Trade ID"])\n        col_vwap = find_col(df, ["VWAP"])\n\n        out = pd.DataFrame()\n        out["Timestamp"] = df["Timestamp"]\n        out["CF TICK"] = df[col_tick] if col_tick else ""\n        out["AGGRESSIVE ORD1"] = df[col_aggr] if col_aggr else ""\n        out["LAST"] = df[col_last] if col_last else np.nan\n        out["CF BID"] = df[col_bid] if col_bid else np.nan\n        out["CF ASK"] = df[col_ask] if col_ask else np.nan\n        out["BID SIZE"] = df[col_bsize] if col_bsize else 0\n        out["ASK SIZE"] = df[col_asize] if col_asize else 0\n        out["NUM BID ORDERS 1"] = df[col_numbo] if col_numbo else 0\n        out["NUM ASK ORDERS 1"] = df[col_numao] if col_numao else 0\n        out["NUMBER OF ORDERS"] = df[col_nord] if col_nord else 0\n        out["TRADE VOL"] = df[col_trdvol] if col_trdvol else 0\n        out["CF VOLUME"] = df[col_cfvol] if col_cfvol else 0\n        out["ELIGBL TRD ACVOL"] = df[col_acvol] if col_acvol else 0\n        out["NUMBER TRADES"] = df[col_ntrd] if col_ntrd else 0\n        out["TRADE_ID"] = df[col_tid] if col_tid else 0\n        out["VWAP"] = df[col_vwap] if col_vwap else np.nan\n\n        out["AGGRESSIVE ORD1"] = (\n            out["AGGRESSIVE ORD1"].astype(str).str.strip()\n            .replace(r"^\\s*$", np.nan, regex=True)\n            .ffill().bfill()\n        )\n\n        out["CF TICK"] = out["CF TICK"].astype(str).str.strip()\n\n        numeric_cols = [\n            "LAST", "CF BID", "CF ASK", "BID SIZE", "ASK SIZE",\n            "NUM BID ORDERS 1", "NUM ASK ORDERS 1", "NUMBER OF ORDERS",\n            "TRADE VOL", "CF VOLUME", "ELIGBL TRD ACVOL",\n            "NUMBER TRADES", "TRADE_ID", "VWAP"\n        ]\n\n        for c in numeric_cols:\n            out[c] = (\n                out[c].astype(str)\n                .str.replace(" ", "", regex=False)\n                .str.replace(",", ".", regex=False)\n            )\n            out[c] = pd.to_numeric(out[c], errors="coerce")\n\n        for c in ["LAST", "CF BID", "CF ASK", "AGGRESSIVE ORD1", "CF TICK"]:\n            out[c] = out[c].ffill().bfill()\n\n        for c in ["BID SIZE", "ASK SIZE", "NUM BID ORDERS 1", "NUM ASK ORDERS 1", "NUMBER OF ORDERS", "TRADE VOL"]:\n            out[c] = out[c].fillna(0)\n\n        before = len(out)\n        out = out.drop_duplicates(subset=["Timestamp", "LAST", "TRADE_ID"], keep="first")\n        if before != len(out):\n            log.info("Dropped %d duplicates", before - len(out))\n\n        out = out.reset_index(drop=True)\n\n        orig = out["TRADE_ID"].copy()\n        out["TRADE_ID_DIFF"] = out["TRADE_ID"].diff().abs().shift(-1)\n        out["TRADE_ID_DIFF"] = fillna_with_last_digits(orig, out["TRADE_ID_DIFF"], digits=2)\n\n        orig = out["NUMBER TRADES"].copy()\n        out["NUMBER_TRADES_DIFF"] = out["NUMBER TRADES"].diff().abs().shift(-1)\n        out["NUMBER_TRADES_DIFF"] = fillna_with_last_digits(orig, out["NUMBER_TRADES_DIFF"], digits=2)\n\n        orig = out["CF VOLUME"].copy()\n        out["CF_VOLUME_DIFF"] = out["CF VOLUME"].diff().abs()\n        out["CF_VOLUME_DIFF"] = fillna_with_last_digits(orig, out["CF_VOLUME_DIFF"], digits=2)\n\n        orig = out["ELIGBL TRD ACVOL"].copy()\n        out["ELIGBL_TRD_ACVOL_DIFF"] = out["ELIGBL TRD ACVOL"].diff().abs()\n        out["ELIGBL_TRD_ACVOL_DIFF"] = fillna_with_last_digits(orig, out["ELIGBL_TRD_ACVOL_DIFF"], digits=2)\n\n        return out\n\n    @staticmethod\n    def norm_aggr(v):\n        s = safe_str(v).upper()\n        if s in ("BID", "B", "1"):\n            return "BID"\n        if s in ("ASK", "A", "2", "S"):\n            return "ASK"\n        return s\n\n    def to_html_rows(self, df):\n        rows = []\n        for _, r in df.iterrows():\n            parsed = pd.to_datetime(r.get("Timestamp"), errors="coerce")\n            time_str = parsed.strftime("%H:%M:%S") if pd.notna(parsed) else ""\n            date_str = parsed.strftime("%Y-%m-%d") if pd.notna(parsed) else ""\n\n            trade_id_raw = safe_num(r.get("TRADE_ID"))\n            number_trades_raw = safe_num(r.get("NUMBER TRADES"))\n            cf_volume_raw = safe_num(r.get("CF VOLUME"))\n            elig_acvol_raw = safe_num(r.get("ELIGBL TRD ACVOL"))\n            trade_id_diff = safe_num(r.get("TRADE_ID_DIFF"))\n            ntrd_diff = safe_num(r.get("NUMBER_TRADES_DIFF"))\n            cfvol_diff = safe_num(r.get("CF_VOLUME_DIFF"))\n            acvol_diff = safe_num(r.get("ELIGBL_TRD_ACVOL_DIFF"))\n\n            rows.append({\n                "last": safe_num(r.get("LAST")),\n                "bid": safe_num(r.get("CF BID")),\n                "ask": safe_num(r.get("CF ASK")),\n                "bSize": safe_num(r.get("BID SIZE")),\n                "aSize": safe_num(r.get("ASK SIZE")),\n                "trdVol": safe_num(r.get("TRADE VOL")),\n                "volume": cfvol_diff if cfvol_diff else safe_num(r.get("TRADE VOL")),\n                "aggr": self.norm_aggr(r.get("AGGRESSIVE ORD1")),\n\n                "tradeId": str(int(trade_id_raw)) if trade_id_raw else "",\n                "rawTradeId": trade_id_raw,\n                "rawNumberTrades": number_trades_raw,\n                "rawCfVolume": cf_volume_raw,\n                "rawEligAcvol": elig_acvol_raw,\n                "trdIdDiff": trade_id_diff,\n                "seqNum": ntrd_diff,\n                "seqNumDiff": ntrd_diff,\n                "moves": acvol_diff,\n                "rtCount": acvol_diff,\n                "movesDiff": acvol_diff,\n                "volDiff": cfvol_diff,\n\n                "numTrades": ntrd_diff,\n                "numberTrades": ntrd_diff,\n                "numberOfOrders": safe_num(r.get("NUMBER OF ORDERS")),\n                "numBidOrders": safe_num(r.get("NUM BID ORDERS 1")),\n                "numAskOrders": safe_num(r.get("NUM ASK ORDERS 1")),\n                "vwap": safe_num(r.get("VWAP")),\n                "tick": safe_str(r.get("CF TICK")),\n                "condKey": "",\n                "time": time_str,\n                "date": date_str,\n            })\n        return rows\n\n\nclass FileState:\n    def __init__(self, path):\n        self.path = str(Path(path).resolve())\n        self.name = Path(self.path).name\n        self.processor = CFProcessor()\n        self.wb = None\n        self.sheet = None\n        self.header_row = None\n        self.data_row = None\n        self.headers = []\n        self.last_signature = ""\n        self.all_rows = []\n\n\ndef find_workbook(path):\n    target = Path(path).name.lower()\n    full = str(Path(path).resolve()).lower()\n    try:\n        books = list(xw.books)\n    except Exception:\n        return None\n\n    for b in books:\n        try:\n            bname = Path(b.fullname).name.lower()\n            bfull = str(Path(b.fullname).resolve()).lower()\n            if bname == target or bfull == full:\n                return b\n        except Exception:\n            continue\n    return None\n\n\ndef choose_sheet_if_needed(wb):\n    sheets = list(wb.sheets)\n    if len(sheets) == 1:\n        return sheets[0]\n    print("\\nAvailable sheets:")\n    for i, s in enumerate(sheets, start=1):\n        print(f"{i}. {s.name}")\n    while True:\n        try:\n            idx = int(input("Select sheet number: ").strip())\n            if 1 <= idx <= len(sheets):\n                return sheets[idx - 1]\n        except Exception:\n            pass\n        print("Invalid sheet number.")\n\n\ndef detect_header(sheet):\n    for row in range(1, AUTO_HEADER_SCAN_ROWS + 1):\n        try:\n            values = sheet.range((row, 1), (row, MAX_READ_COLS)).value\n        except Exception:\n            continue\n\n        if not isinstance(values, list):\n            values = [values]\n\n        headers = [clean_header(v) for v in values]\n        normed = {norm_key(h) for h in headers if h}\n        score = 0\n        for key in ["TIMESTAMP", "ACTIVEDATE", "TIMEACTNS", "LAST", "CFBID", "CFASK", "TRADEVOL", "TRADEID"]:\n            if key in normed:\n                score += 1\n        if "CFTICK" in normed:\n            score += 1\n        if "AGGRESSIVEORD1" in normed:\n            score += 1\n\n        if score >= 4:\n            while headers and headers[-1] == "":\n                headers.pop()\n            return row, row + 1, headers\n\n    raise RuntimeError("Could not detect header row.")\n\n\ndef read_excel_snapshot(state):\n    if state.wb is None:\n        state.wb = find_workbook(state.path)\n        if state.wb is None:\n            log.warning("[%s] Not open in Excel yet — waiting", state.name)\n            return None\n        state.sheet = choose_sheet_if_needed(state.wb)\n        state.header_row, state.data_row, state.headers = detect_header(state.sheet)\n        log.info("[%s] Header row %s: %s", state.name, state.header_row, state.headers)\n\n    try:\n        used = state.sheet.used_range\n        last_row = used.last_cell.row\n        last_col = min(used.last_cell.column, len(state.headers))\n    except Exception:\n        state.wb = None\n        state.sheet = None\n        return None\n\n    if last_row < state.data_row:\n        return []\n\n    try:\n        data = state.sheet.range((state.data_row, 1), (last_row, last_col)).value\n    except Exception:\n        return None\n\n    if data is None:\n        return []\n    if data and not isinstance(data[0], list):\n        data = [data]\n\n    data = [row for row in data if row and any(c is not None and safe_str(c) != "" for c in row)]\n    if not data:\n        return []\n\n    headers = state.headers[:last_col]\n    fixed_data = []\n    for row in data:\n        row = list(row)\n        if len(row) < len(headers):\n            row += [None] * (len(headers) - len(row))\n        fixed_data.append(row[:len(headers)])\n\n    df_raw = pd.DataFrame(fixed_data, columns=headers)\n    rows = state.processor.process(df_raw)\n\n    if rows:\n        last = rows[-1]\n        sig = f"{len(rows)}|{last.get(\'date\')}|{last.get(\'time\')}|{last.get(\'last\')}|{last.get(\'tradeId\')}|{last.get(\'trdIdDiff\')}"\n    else:\n        sig = "0"\n\n    if sig == state.last_signature:\n        return []\n\n    state.last_signature = sig\n    state.all_rows = rows\n    return rows\n\n\nasync def send(ws, obj):\n    try:\n        await ws.send(safe_json(obj))\n    except Exception:\n        pass\n\n\nasync def broadcast(obj):\n    msg = safe_json(obj)\n    dead = set()\n    for ws in list(_clients):\n        try:\n            await ws.send(msg)\n        except Exception:\n            dead.add(ws)\n    _clients.difference_update(dead)\n\n\nasync def ws_handler(ws, path=None):\n    _clients.add(ws)\n    log.info("Client connected")\n    try:\n        await send(ws, {\n            "type": "connected",\n            "server": "xlwings-orderflow-cf-manual-picker",\n            "version": "v1",\n            "files": [state.name for state in FILE_STATES],\n        })\n\n        for state in FILE_STATES:\n            if state.all_rows:\n                await send(ws, {\n                    "type": "snapshot",\n                    "file": state.name,\n                    "rows": state.all_rows,\n                    "total": len(state.all_rows),\n                    "ts": datetime.now().strftime("%H:%M:%S"),\n                })\n\n        async for raw in ws:\n            try:\n                msg = json.loads(raw)\n            except Exception:\n                continue\n            cmd = msg.get("type") or msg.get("cmd")\n            if cmd == "ping":\n                await send(ws, {"type": "pong", "ts": datetime.now().strftime("%H:%M:%S")})\n            elif cmd == "save":\n                saved = {}\n                for state in FILE_STATES:\n                    df = state.processor.cleaned_df\n                    if df is not None and not df.empty:\n                        out = Path(state.path).with_name(Path(state.path).stem + "_cleaned.xlsx")\n                        df.to_excel(out, index=False)\n                        saved[state.name] = str(out)\n                await send(ws, {"type": "saved", "files": saved})\n    except websockets.exceptions.ConnectionClosed:\n        pass\n    finally:\n        _clients.discard(ws)\n        log.info("Client disconnected")\n\n\nasync def poll_loop():\n    log.info("Polling every %.3fs", POLL_INTERVAL)\n    while True:\n        await asyncio.sleep(POLL_INTERVAL)\n        for state in FILE_STATES:\n            try:\n                rows = read_excel_snapshot(state)\n            except Exception as exc:\n                log.error("Read/process error: %s", exc, exc_info=True)\n                continue\n\n            if rows is None or not rows:\n                continue\n\n            await broadcast({\n                "type": "snapshot",\n                "file": state.name,\n                "rows": rows,\n                "total": len(rows),\n                "ts": datetime.now().strftime("%H:%M:%S"),\n            })\n            log.info("[%s] sent rows=%d", state.name, len(rows))\n\n\nasync def start_server():\n    try:\n        async with websockets.serve(\n            ws_handler, WS_HOST, WS_PORT,\n            ping_interval=30,\n            ping_timeout=10,\n            max_size=2**24\n        ):\n            log.info("ws://%s:%s ready", WS_HOST, WS_PORT)\n            await poll_loop()\n    except TypeError:\n        async def handler_v14(ws):\n            await ws_handler(ws)\n        async with websockets.serve(\n            handler_v14, WS_HOST, WS_PORT,\n            ping_interval=30,\n            ping_timeout=10,\n            max_size=2**24\n        ):\n            log.info("ws://%s:%s ready", WS_HOST, WS_PORT)\n            await poll_loop()\n\n\nasync def main():\n    global WS_PORT, POLL_INTERVAL, FILE_STATES\n\n    parser = argparse.ArgumentParser()\n    parser.add_argument("file", nargs="?", help="Optional Excel file path")\n    parser.add_argument("--port", type=int, default=8766)\n    parser.add_argument("--interval", type=float, default=0.05)\n    args = parser.parse_args()\n\n    WS_PORT = args.port\n    POLL_INTERVAL = args.interval\n\n    selected_file = args.file if args.file else choose_excel_file()\n    selected_file = str(Path(selected_file).resolve())\n    FILE_STATES = [FileState(selected_file)]\n\n    log.info("=" * 70)\n    log.info("OrderFlow xlwings bridge — manual workbook picker")\n    log.info("File: %s", selected_file)\n    log.info("WS: ws://%s:%s | interval %.3fs", WS_HOST, WS_PORT, POLL_INTERVAL)\n    log.info("=" * 70)\n\n    state = FILE_STATES[0]\n    state.wb = find_workbook(state.path)\n    if state.wb is None:\n        log.warning("[%s] Selected file is not open in Excel yet. Open it and keep it open.", state.name)\n    else:\n        log.info("[%s] Found open workbook: %s", state.name, state.wb.fullname)\n        state.sheet = choose_sheet_if_needed(state.wb)\n        state.header_row, state.data_row, state.headers = detect_header(state.sheet)\n        log.info("[%s] Header row %s: %s", state.name, state.header_row, state.headers)\n        seed = read_excel_snapshot(state)\n        if seed:\n            log.info("[%s] Seeded rows=%d", state.name, len(seed))\n\n    await start_server()\n\n\nif __name__ == "__main__":\n    try:\n        asyncio.run(main())\n    except KeyboardInterrupt:\n        log.info("Stopped.")\n'

def _load_embedded(source: str, name: str) -> dict:
    ns = {"__name__": name, "__file__": f"<embedded-{name}>"}
    exec(compile(source, f"<embedded-{name}>", "exec"), ns, ns)
    return ns

def _use_populated_extent(source: str) -> str:
    """Avoid polling an RFV formula's reserved 220,000-row used range."""
    # Duplicate removal is expected for overlapping live windows; keep it out
    # of the normal INFO log so real connection errors remain visible.
    source = source.replace(
        'log.info("Dropped %d duplicates", before - len(out))',
        'log.debug("Dropped %d duplicates", before - len(out))',
    )
    source = source.replace(
        "used = sheet.used_range\n"
        "        last_col = int(used.last_cell.column)\n"
        "        last_row = int(used.last_cell.row)",
        "last_row = int(sheet.api.Cells(sheet.api.Rows.Count, 1).End(-4162).Row)\n"
        "        last_col = int(sheet.api.Cells(HEADER_ROW, sheet.api.Columns.Count).End(-4159).Column)",
    )
    source = source.replace(
        "used = state.sheet.used_range\n"
        "        last_row = used.last_cell.row\n"
        "        last_col = min(used.last_cell.column, len(state.headers))",
        "last_row = int(state.sheet.api.Cells(state.sheet.api.Rows.Count, 1).End(-4162).Row)\n"
        "        last_col = len(state.headers)",
    )
    source = source.replace(
        "ts_raw = sheet.range(f\"A{DATA_START_ROW}:A{last_row}\").value\n"
        "    except Exception:\n"
        "        state._wb_ref = None\n"
        "        state._sheet_ref = None\n"
        "        return None\n"
        "    if not isinstance(ts_raw, list):\n"
        "        ts_raw = [ts_raw]\n"
        "    ext = _active_extent(ts_raw)\n"
        "    if ext is None:\n"
        "        return []\n"
        "    active_last = DATA_START_ROW + ext",
        "probe_start = max(DATA_START_ROW, last_row - 31)\n"
        "        ts_raw = sheet.range(f\"A{probe_start}:A{last_row}\").value\n"
        "    except Exception:\n"
        "        state._wb_ref = None\n"
        "        state._sheet_ref = None\n"
        "        return None\n"
        "    if not isinstance(ts_raw, list):\n"
        "        ts_raw = [ts_raw]\n"
        "    if _active_extent(ts_raw) is None:\n"
        "        return []\n"
        "    ext = len(ts_raw) - 1\n"
        "    active_last = last_row",
    )
    return source

def _limit_taq_live_window(source: str) -> str:
    """TAQ seeds once, then rereads only its changing 2,500-row edge."""
    source = source.replace(
        "start_row, end_row = DATA_START_ROW, active_last\n"
        "    reset_processor = bool(seed or state._last_excel_row < DATA_START_ROW)",
        "reset_processor = bool(seed or state._last_excel_row < DATA_START_ROW)\n"
        "    if reset_processor:\n"
        "        start_row, end_row = DATA_START_ROW, active_last\n"
        "    elif order == \"desc\":\n"
        "        start_row = DATA_START_ROW\n"
        "        end_row = min(active_last, DATA_START_ROW + 2499)\n"
        "    else:\n"
        "        start_row = max(DATA_START_ROW, active_last - 2499)\n"
        "        end_row = active_last",
    )
    source = source.replace(
        "sig = f\"{active_last}|{head_sig}|{tail_sig}\"\n"
        "    if not reset_processor and sig == state._last_tail_signature:\n"
        "        state._last_excel_row = active_last\n"
        "        return []\n"
        "    state._last_tail_signature = sig\n"
        "    state._last_excel_row = active_last",
        "previous_head = getattr(state, \"_last_head_signature\", None)\n"
        "    previous_tail = getattr(state, \"_last_edge_tail_signature\", None)\n"
        "    head_changed = head_sig != previous_head\n"
        "    tail_changed = tail_sig != previous_tail\n"
        "    if not reset_processor and not head_changed and not tail_changed:\n"
        "        state._last_excel_row = active_last\n"
        "        return []\n"
        "    state._last_head_signature = head_sig\n"
        "    state._last_edge_tail_signature = tail_sig\n"
        "    state._last_tail_signature = f\"{active_last}|{head_sig}|{tail_sig}\"\n"
        "    state._last_excel_row = active_last\n"
        "    if not reset_processor and head_changed and not tail_changed:\n"
        "        start_row = DATA_START_ROW\n"
        "        end_row = min(active_last, DATA_START_ROW + 2499)\n"
        "    elif not reset_processor and tail_changed and not head_changed:\n"
        "        start_row = max(DATA_START_ROW, active_last - 2499)\n"
        "        end_row = active_last",
    )
    # Do not hold current TAQ rows while waiting for a future QUALIFIERS side.
    # The processor already ffill/bfills the best available side; emit it now.
    source = source.replace(
        "stable = bool(conv[\"_side_stable\"].iloc[i]) or (conv[\"_side_raw\"].iloc[i] in (\"⇧\", \"⇩\"))\n"
        "            if not stable:\n"
        "                continue  # held until a newer sided tick fixes its ffill source",
        "stable = True  # immediate live mode: use the currently resolved side",
    )
    return source

TAS = _load_embedded(_use_populated_extent(_TAS_SOURCE), "orderflow_embedded_tas")
TAQ = _load_embedded(_limit_taq_live_window(_use_populated_extent(_TAQ_SOURCE)), "orderflow_embedded_taq")
CF  = _load_embedded(_use_populated_extent(_CF_SOURCE),  "orderflow_embedded_cf")


def _install_orderflow_gcv_schema_compat():
    # Adapt the user's real GCV workbook shape without modifying embedded bridge code.
    cls = CF["CFProcessor"]
    if getattr(cls, "_orderflow_gcv_schema_compat_v3", False):
        return

    original_process = cls.process

    def process_compat(self, df_raw):
        df = df_raw.copy()

        # User's GCV uses Trd.Vol; existing processor expects TRADE VOL.
        if "Trd.Vol" in df.columns and "TRADE VOL" not in df.columns:
            df["TRADE VOL"] = df["Trd.Vol"]

        # Some GCV files have TIMEACT NS but no date column.
        # Preserve a real date if present. Otherwise recover YYYY-MM-DD
        # from the selected filename; for a live file without a date
        # in its filename, use today's date.
        norm = {
            re.sub(r"[^A-Z0-9]+", "", str(c).upper().strip()): c
            for c in df.columns
        }
        has_timestamp = "TIMESTAMP" in norm
        has_date = any(k in norm for k in ("ACTIVEDATE", "DATEOFUPDATE", "DATE"))
        has_timeact = "TIMEACTNS" in norm

        if (not has_timestamp) and (not has_date) and has_timeact:
            src = str(getattr(self, "_orderflow_source_path", "") or "")
            m = re.search(r"(20\d{2})[-_](\d{2})[-_](\d{2})", src)
            if m:
                fallback_date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            else:
                fallback_date = pd.Timestamp.now().strftime("%Y-%m-%d")
            df["ACTIVE DATE"] = fallback_date

        return original_process(self, df)

    cls.process = process_compat
    cls._orderflow_gcv_schema_compat_v3 = True


_install_orderflow_gcv_schema_compat()

WS_HOST = "localhost"
WS_PORT = 8766
POLL_INTERVAL = 0.25
MAX_WS_SIZE = 2 ** 25
LIVE_WINDOW_ROWS = 2500

# id -> UnifiedState
STATES: dict[str, "UnifiedState"] = {}
CLIENTS: set[Any] = set()
CLIENT_PREFS: dict[Any, dict] = {}

# GUI -> asyncio control queue. The source-manager window runs in a Tk thread;
# the bridge remains on the asyncio thread.
CONTROL_QUEUE: "queue.Queue[dict]" = queue.Queue()
GUI_STATUS_QUEUE: "queue.Queue[dict]" = queue.Queue()
SOURCE_LABELS = {"taq": "TAQ", "tas": "TAS", "cf": "NEW_GCv1 / CF"}

def now_ms() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]

# Every xlwings/Excel COM call is executed on this one persistent worker.
# This keeps COM objects on one thread and prevents slow Excel reads from
# blocking WebSocket clients, heartbeats, or the source-manager GUI.
EXCEL_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="OrderFlowExcelCOM")
_EXCEL_THREAD = threading.local()

def _excel_worker_call(func, *args):
    if not getattr(_EXCEL_THREAD, "com_ready", False):
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except Exception:
            pass
        _EXCEL_THREAD.com_ready = True
    return func(*args)

async def excel_call(func, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(EXCEL_EXECUTOR, _excel_worker_call, func, *args)

def safe_json(obj):
    def clean(v):
        if isinstance(v, float):
            return 0 if math.isnan(v) or math.isinf(v) else v
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(x) for x in v]
        if hasattr(v, "item"):
            try:
                return clean(v.item())
            except Exception:
                pass
        return v
    return json.dumps(clean(obj), ensure_ascii=False, separators=(",", ":"))

def clean_path(raw: str) -> str:
    p = Path(raw).resolve()
    if p.name.startswith("~$"):
        real = p.parent / p.name[2:]
        if real.exists():
            p = real
    return str(p)

# BRIDGE_OWNED_EXCEL_V7_COM_FIX
# Some Windows/RDP/Office configurations don't publish a manually opened
# Excel instance in the Running Object Table. In that case xw.apps and
# GetActiveObject return zero even though EXCEL.EXE is visible.
#
# The V7 unified bridge therefore owns one Excel COM instance on its
# persistent Excel worker thread and opens the selected workbooks itself.
_OWNED_EXCEL_APP = None
_OWNED_BOOKS: dict[str, Any] = {}

def _book_is_valid(book) -> bool:
    try:
        _ = book.name
        _ = book.fullname
        return True
    except Exception:
        return False

def open_books():
    books = []

    try:
        for app in list(xw.apps):
            try:
                books.extend(list(app.books))
            except Exception:
                continue
    except Exception:
        pass

    # Also include books owned directly by this bridge even on machines
    # where Excel is not discoverable through the Running Object Table.
    for key, book in list(_OWNED_BOOKS.items()):
        if _book_is_valid(book):
            if book not in books:
                books.append(book)
        else:
            _OWNED_BOOKS.pop(key, None)

    return books

def _get_or_create_owned_excel():
    global _OWNED_EXCEL_APP

    try:
        if _OWNED_EXCEL_APP is not None:
            _ = _OWNED_EXCEL_APP.api.Hwnd
            return _OWNED_EXCEL_APP
    except Exception:
        _OWNED_EXCEL_APP = None

    app = xw.App(visible=True, add_book=False)

    try:
        app.display_alerts = True
    except Exception:
        pass

    _OWNED_EXCEL_APP = app

    log.info(
        "Bridge-owned Excel started (PID %s)",
        getattr(app, "pid", "?")
    )

    return app

def find_book(path: str, open_if_missing: bool = True):
    full_path = str(Path(path).resolve())
    target = Path(full_path).name.lower().lstrip("~$")
    full_target = full_path.lower()

    cached = _OWNED_BOOKS.get(full_target)

    if cached is not None and _book_is_valid(cached):
        return cached

    _OWNED_BOOKS.pop(full_target, None)

    # First try any discoverable/open workbook.
    for b in open_books():
        try:
            full = str(Path(b.fullname).resolve())
            name = Path(full).name.lower().lstrip("~$")

            if name == target or full.lower() == full_target:
                _OWNED_BOOKS[full_target] = b
                return b
        except Exception:
            continue

    if not open_if_missing:
        return None

    if not Path(full_path).exists():
        return None

    # ROT discovery failed: open it ourselves in the bridge-owned Excel.
    try:
        app = _get_or_create_owned_excel()

        log.info(
            "Opening workbook in bridge-owned Excel: %s",
            full_path
        )

        book = app.books.open(
            full_path,
            update_links=False,
            read_only=False
        )

        _OWNED_BOOKS[full_target] = book
        return book

    except Exception as exc:
        log.warning(
            "Could not open workbook through bridge-owned Excel [%s]: %s",
            Path(full_path).name,
            exc
        )
        return None

# AUTO_OPEN_VISIBLE_WORKBOOK_V3
def _show_excel_workbook(wb):
    if wb is None:
        return None

    try:
        app = wb.app
    except Exception:
        return wb

    try:
        app.visible = True
    except Exception:
        pass

    try:
        app.api.Visible = True
    except Exception:
        pass

    try:
        app.api.WindowState = -4143
    except Exception:
        pass

    try:
        wins = wb.api.Windows
        for i in range(1, int(wins.Count) + 1):
            try:
                win = wins.Item(i)
                win.Visible = True
                win.WindowState = -4143
            except Exception:
                pass
    except Exception:
        pass

    try:
        wb.activate()
    except Exception:
        pass

    try:
        app.activate(steal_focus=True)
    except Exception:
        try:
            app.activate()
        except Exception:
            pass

    try:
        import ctypes as _ctypes
        hwnd = int(app.api.Hwnd)
        if hwnd:
            _ctypes.windll.user32.ShowWindow(hwnd, 9)
            _ctypes.windll.user32.ShowWindow(hwnd, 5)
            _ctypes.windll.user32.SetForegroundWindow(hwnd)
    except Exception:
        pass

    try:
        log.info("[AUTO-OPEN] visible on desktop: %s", Path(wb.fullname).name)
    except Exception:
        log.info("[AUTO-OPEN] workbook made visible on desktop")

    return wb


def ensure_excel_open(path: str, wait_seconds: float = 25.0):
    import os as _os
    import time as _time

    path = clean_path(path)

    wb = find_book(path)
    if wb is not None:
        log.info("[AUTO-OPEN] already open: %s", Path(path).name)
        return _show_excel_workbook(wb)

    if not Path(path).exists():
        log.warning("[AUTO-OPEN] file not found: %s", path)
        return None

    try:
        log.info("[AUTO-OPEN] opening in Excel: %s", Path(path).name)
        _os.startfile(path)
    except Exception as exc:
        log.warning("[AUTO-OPEN] Windows could not launch %s: %s", Path(path).name, exc)
        return None

    deadline = _time.monotonic() + max(1.0, float(wait_seconds))
    while _time.monotonic() < deadline:
        _time.sleep(0.50)
        wb = find_book(path)
        if wb is not None:
            log.info("[AUTO-OPEN] Excel ready: %s", Path(path).name)
            return _show_excel_workbook(wb)

    log.warning(
        "[AUTO-OPEN] %s launched but xlwings did not see it within %.1fs; polling will keep waiting.",
        Path(path).name, wait_seconds
    )
    return None


def normalized_header(v):
    return re.sub(r"[^A-Z0-9]+", "", str(v or "").upper().strip())

def scan_headers(path: str):
    wb = find_book(path)
    if wb is None:
        return [], None, None
    try:
        sh = wb.sheets[0]
    except Exception:
        return [], wb, None

    best = []
    best_row = None
    # Scan enough rows to support CF's auto-header layout as well as TAS/TAQ row 3.
    for row in range(1, 26):
        try:
            vals = sh.range((row, 1), (row, 100)).value
        except Exception:
            continue
        if not isinstance(vals, list):
            vals = [vals]
        vals = [str(x).strip() if x is not None else "" for x in vals]
        while vals and not vals[-1]:
            vals.pop()
        if len([x for x in vals if x]) > len([x for x in best if x]):
            best, best_row = vals, row

        n = {normalized_header(x) for x in vals if x}
        # Stop early once a strong recognizable row is found.
        if (
            {"TRDPRC1","AGGRSSID1","TRDVOL1"} <= n
            or {"BID","ASK","BIDSIZE","ASKSIZE","SEQNUM","RTL"} <= n
            or len(n & {"CFTICK","LAST","CFBID","CFASK","TRADEVOL","TRADEID","NUMBERTRADES"}) >= 4
        ):
            return vals, wb, row
    return best, wb, best_row

def detect_source(path: str) -> tuple[str|None, int|None]:
    headers, wb, row = scan_headers(path)
    n = {normalized_header(x) for x in headers if x}

    # TAS raw layout.
    if (
        "TRDPRC1" in n
        and "TRDVOL1" in n
        and ("AGGRSSID1" in n or "PRCTCK1" in n)
    ):
        return "tas", row

    # TAQ raw layout.
    if (
        {"BID", "ASK", "BIDSIZE", "ASKSIZE", "SEQNUM", "RTL"} <= n
        and "TRDPRC1" not in n
    ):
        return "taq", row

    # User's real GCV layout.
    gcv_score = len(n & {
        "TIMEACTNS", "TICK", "LAST", "BID", "ASK",
        "BSIZE", "ASIZE", "BIDSIZE", "ASKSIZE",
        "NUMBIDORDERS1", "NUMASKORDERS1", "NUMBEROFORDERS",
        "TRDVOL", "TRADEVOL", "TRDVOL1",
        "VOLUME", "CFVOLUME",
        "ELIGBLTRDACVOL", "MOVES", "NUMBERTRADES",
        "AGGRESSIVEORD1", "TRADEID", "VWAP",
    })
    if (
        "LAST" in n
        and "TRADEID" in n
        and (("BID" in n and "ASK" in n) or ("CFBID" in n and "CFASK" in n))
        and gcv_score >= 7
    ):
        return "cf", row

    # Existing CF / Pro compatibility.
    cf_score = len(n & {
        "CFTICK", "LAST", "CFBID", "CFASK", "BIDSIZE", "ASKSIZE",
        "TRADEVOL", "CFVOLUME", "NUMBERTRADES", "TRADEID", "VWAP",
    })
    if cf_score >= 4:
        return "cf", row

    return None, row

class UnifiedState:
    def __init__(self, path: str, source: str, header_row: int|None):
        self.path = clean_path(path)
        self.source = source
        self.name = Path(self.path).name
        self.id = f"{source}::{self.name}"
        self.header_row = header_row
        self.last_rows = 0
        self.last_error = ""
        self._cf_known_keys: set[str] = set()
        self._cf_edge_signature = ""
        self.recommended_delay = 0.0
        self.inner = self._make_inner()

    @staticmethod
    def _cf_row_key(row: dict) -> str:
        return "|".join((
            str(row.get("date") or ""), str(row.get("time") or ""),
            str(row.get("tradeId") or ""), str(row.get("last") or "")
        ))

    def _make_inner(self):
        if self.source == "tas":
            # Configure embedded module globals for this workbook shape.
            if self.header_row:
                TAS["HEADER_ROW"] = self.header_row
                TAS["DATA_START_ROW"] = self.header_row + 1
            st = TAS["FileState"](self.path)
            return st

        if self.source == "taq":
            if self.header_row:
                TAQ["HEADER_ROW"] = self.header_row
                TAQ["DATA_START_ROW"] = self.header_row + 1
            st = TAQ["FileState"](self.path)
            return st

        if self.source == "cf":
            st = CF["FileState"](self.path)
            st.processor._orderflow_source_path = self.path
            # CF discovers sheet/header itself.
            return st
        raise ValueError(self.source)

    def seed(self):
        if not self._excel_is_ready():
            return []
        if self.source == "tas":
            rows = TAS["read_rows_for"](self.inner, seed=True)
            self.last_rows = len(self.inner.all_rows)
            return rows
        if self.source == "taq":
            rows = TAQ["read_rows_for"](self.inner, seed=True)
            self.last_rows = len(self.inner.all_rows)
            return rows
        if self.source == "cf":
            rows = CF["read_excel_snapshot"](self.inner)
            self.last_rows = len(self.inner.all_rows)
            if rows:
                self._cf_known_keys = {self._cf_row_key(r) for r in rows}
            return rows
        return []

    def _workbook_and_sheet(self):
        if self.source in ("tas", "taq"):
            module = TAS if self.source == "tas" else TAQ

            # Give the embedded TAQ/TAS reader the bridge-owned COM workbook.
            # This bypasses the legacy xw.apps discovery path when Windows ROT
            # doesn't expose the manually opened Excel instance.
            try:
                if getattr(self.inner, "_wb_ref", None) is None:
                    self.inner._wb_ref = find_book(
                        self.path,
                        open_if_missing=True
                    )
                    self.inner._sheet_ref = None
            except Exception:
                pass

            return module["_get_workbook_and_sheet"](self.inner)

        if self.inner.wb is None:
            self.inner.wb = find_book(
                self.path,
                open_if_missing=True
            )

            if self.inner.wb is not None:
                self.inner.sheet = CF["choose_sheet_if_needed"](self.inner.wb)
        if self.inner.sheet is not None and not self.inner.headers:
            (self.inner.header_row, self.inner.data_row,
             self.inner.headers) = CF["detect_header"](self.inner.sheet)
        return self.inner.wb, self.inner.sheet

    def _excel_is_ready(self) -> bool:
        """Never compete with Excel or Refinitiv while an async refresh is busy."""
        wb, sheet = self._workbook_and_sheet()
        if wb is None or sheet is None:
            self.recommended_delay = 2.0
            return False
        try:
            if int(wb.app.api.CalculationState) != 0:  # 0 = xlDone
                self.last_error = "Excel is calculating; live read deferred"
                self.recommended_delay = 0.10
                return False
        except Exception:
            pass
        try:
            if "retrieving" in repr(sheet.range("A1:D2").value).lower():
                self.last_error = "Refinitiv is retrieving; live read deferred"
                self.recommended_delay = 0.25
                return False
        except Exception:
            self.recommended_delay = 0.25
            return False
        self.recommended_delay = 0.0
        return True

    def _poll_cf_window(self):
        """Process only the changing edge after CF's one-time full seed."""
        state = self.inner
        full_refresh = state.wb is None or state.sheet is None or not state.headers
        if full_refresh:
            rows = CF["read_excel_snapshot"](state)
        else:
            sheet = state.sheet
            last_row = int(sheet.api.Cells(sheet.api.Rows.Count, 1).End(-4162).Row)
            last_col = len(state.headers)
            if last_row < state.data_row:
                return []
            snapshot = state.all_rows or []
            ascending = True
            if len(snapshot) > 1:
                first = f"{snapshot[0].get('date','')} {snapshot[0].get('time','')}"
                last = f"{snapshot[-1].get('date','')} {snapshot[-1].get('time','')}"
                ascending = first <= last
            if ascending:
                start_row = max(state.data_row, last_row - LIVE_WINDOW_ROWS + 1)
                end_row = last_row
            else:
                start_row = state.data_row
                end_row = min(last_row, state.data_row + LIVE_WINDOW_ROWS - 1)
            edge_end = min(end_row, start_row + 7)
            if ascending:
                edge_start = max(start_row, end_row - 7)
                edge_end = end_row
            else:
                edge_start = start_row
            edge = sheet.range((edge_start, 1), (edge_end, last_col)).value
            edge_signature = repr(edge)
            if edge_signature == self._cf_edge_signature:
                return []
            self._cf_edge_signature = edge_signature
            data = sheet.range((start_row, 1), (end_row, last_col)).value
            if data is None:
                return []
            if data and not isinstance(data[0], list):
                data = [data]
            headers = state.headers[:last_col]
            fixed = []
            for row in data:
                row = list(row)
                if len(row) < len(headers):
                    row += [None] * (len(headers) - len(row))
                fixed.append(row[:len(headers)])
            rows = state.processor.process(CF["pd"].DataFrame(fixed, columns=headers))

        new_rows = []
        for row in rows or []:
            key = self._cf_row_key(row)
            if key in self._cf_known_keys:
                continue
            self._cf_known_keys.add(key)
            if not full_refresh:
                state.all_rows.append(row)
            new_rows.append(row)
        self.last_rows = len(state.all_rows)
        return new_rows

    def poll(self):
        if not self._excel_is_ready():
            return [], [], 0
        if self.source == "tas":
            rows = TAS["read_rows_for"](self.inner)
            self.last_rows = len(self.inner.all_rows)
            amends = list(self.inner.pending_amends)
            self.inner.pending_amends.clear()
            return rows, amends, getattr(self.inner, "last_spl_trd", 0)
        if self.source == "taq":
            rows = TAQ["read_rows_for"](self.inner)
            self.last_rows = len(self.inner.all_rows)
            amends = list(self.inner.pending_amends)
            self.inner.pending_amends.clear()
            return rows, amends, getattr(self.inner, "last_spl_trd", 0)
        if self.source == "cf":
            return self._poll_cf_window(), [], 0
        return [], [], 0

    def snapshot_rows(self):
        return list(getattr(self.inner, "all_rows", []) or [])

    def save(self):
        if self.source in ("tas", "taq"):
            return self.inner.processor.save_cleaned()
        if self.source == "cf":
            df = self.inner.processor.cleaned_df
            if df is None or df.empty:
                return None
            out = Path(self.path).with_name(Path(self.path).stem + "_cleaned.xlsx")
            df.to_excel(out, index=False)
            return str(out)
        return None

def files_for(source: str):
    return [s for s in STATES.values() if s.source == source]

def public_file_list(source: str):
    return [{"id": s.id, "name": s.name, "source": s.source, "rows": s.last_rows} for s in files_for(source)]

def selected_state(ws):
    pref = CLIENT_PREFS.get(ws, {})
    source = pref.get("source")
    file_id = pref.get("file_id")
    if file_id and file_id in STATES and STATES[file_id].source == source:
        return STATES[file_id]
    items = files_for(source) if source else []
    return items[0] if items else None

async def send(ws, obj):
    try:
        await ws.send(safe_json(obj))
    except Exception:
        pass

async def send_source_files(ws):
    pref = CLIENT_PREFS.get(ws, {})
    source = pref.get("source")
    if not source:
        return
    items = public_file_list(source)
    st = selected_state(ws)
    if st and pref.get("file_id") != st.id:
        pref["file_id"] = st.id
    await send(ws, {
        "type": "source_files",
        "source": source,
        "files": items,
        "selected": st.id if st else None,
    })

async def send_snapshot(ws, st: UnifiedState):
    rows = st.snapshot_rows()
    if not rows:
        try:
            await excel_call(st.seed)
            rows = st.snapshot_rows()
        except Exception as exc:
            log.warning("[%s] seed failed: %s", st.name, exc)
            return
    if rows:
        await send(ws, {
            "type": "snapshot",
            "source": st.source,
            "file": st.name,
            "fileId": st.id,
            "rows": rows,
            "total": len(rows),
            "ts": now_ms(),
            "splTrd": getattr(st.inner, "last_spl_trd", 0),
        })

async def broadcast_state(st: UnifiedState, obj: dict):
    dead = []
    for ws in list(CLIENTS):
        pref = CLIENT_PREFS.get(ws, {})
        if pref.get("source") != st.source:
            continue
        chosen = selected_state(ws)
        if chosen is None or chosen.id != st.id:
            continue
        try:
            await ws.send(safe_json(obj))
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.discard(ws)
        CLIENT_PREFS.pop(ws, None)

async def handler(ws, path=None):
    CLIENTS.add(ws)
    CLIENT_PREFS[ws] = {"source": None, "file_id": None}
    await send(ws, {
        "type": "connected",
        "server": "orderflow-unified-xlwings",
        "version": "1.0",
        "port": WS_PORT,
        "sources": {
            "tas": public_file_list("tas"),
            "taq": public_file_list("taq"),
            "cf": public_file_list("cf"),
        },
    })
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            cmd = msg.get("type") or msg.get("cmd")

            if cmd == "ping":
                await send(ws, {"type":"pong","ts":now_ms()})

            elif cmd == "subscribe":
                source = str(msg.get("source","")).lower()
                if source not in ("tas","taq","cf"):
                    await send(ws, {"type":"error","message":"Unknown source"})
                    continue
                CLIENT_PREFS[ws]["source"] = source
                CLIENT_PREFS[ws]["file_id"] = None
                await send_source_files(ws)
                st = selected_state(ws)
                if st:
                    CLIENT_PREFS[ws]["file_id"] = st.id
                    await send_snapshot(ws, st)

            elif cmd == "select_file":
                source = CLIENT_PREFS[ws].get("source")
                raw_id = str(msg.get("fileId") or "")
                raw_name = str(msg.get("file") or "")
                st = STATES.get(raw_id)
                if st is None and raw_name:
                    st = next((x for x in files_for(source) if x.name == raw_name), None)
                if st is None or st.source != source:
                    await send(ws, {"type":"error","message":"File not available for this tab"})
                    continue
                CLIENT_PREFS[ws]["file_id"] = st.id
                await send_source_files(ws)
                await send_snapshot(ws, st)

            elif cmd == "resync":
                st = selected_state(ws)
                if st:
                    try:
                        # Recreate the state to guarantee a clean seed.
                        newst = UnifiedState(st.path, st.source, st.header_row)
                        STATES[st.id] = newst
                        CLIENT_PREFS[ws]["file_id"] = newst.id
                        await send_snapshot(ws, newst)
                    except Exception as exc:
                        await send(ws, {"type":"error","message":str(exc)})

            elif cmd == "save":
                st = selected_state(ws)
                result = await excel_call(st.save) if st else None
                await send(ws, {
                    "type":"saved",
                    "source": st.source if st else None,
                    "files": {st.name: result} if st else {},
                    "ok": bool(result),
                })
    except Exception:
        pass
    finally:
        CLIENTS.discard(ws)
        CLIENT_PREFS.pop(ws, None)

async def poll_loop():
    cycle = 0
    next_due = {}
    # CF and TAQ inspect wider/recomputed windows than the incremental TAS
    # reader. Pace them independently so Excel still has time to receive and
    # calculate its live Refinitiv updates.
    # Lightweight edge probes at 100 ms; full ranges are read only on change.
    source_interval = {"tas": 0.10, "taq": 0.10, "cf": 0.10}
    while True:
        await asyncio.sleep(0.05)
        cycle += 1

        # Keep ws://localhost:8766 alive even when Excel is closed at startup.
        # About once per second, attach any newly opened TAS / TAQ / CF workbook.
        if cycle == 1 or cycle % 20 == 0:
            try:
                added = await excel_call(discover_open_workbooks)
                for st in added:
                    await _send_all_source_lists(st.source)
            except Exception as exc:
                if cycle % 100 == 0:
                    log.debug("Auto-discovery: %s", exc)

        for st in list(STATES.values()):
            now = time.monotonic()
            due = next_due.get(st.id, 0.0)
            if now < due:
                continue
            next_due[st.id] = now + max(POLL_INTERVAL, source_interval.get(st.source, 0.50))
            try:
                rows, amends, spl = await excel_call(st.poll)
                if st.recommended_delay:
                    next_due[st.id] = time.monotonic() + st.recommended_delay
            except COM_ERR as exc:
                st.last_error = str(exc)
                next_due[st.id] = time.monotonic() + 1.0
                continue
            except Exception as exc:
                st.last_error = str(exc)
                if cycle % 20 == 0:
                    log.warning("[%s/%s] %s", st.source.upper(), st.name, exc)
                next_due[st.id] = time.monotonic() + 1.0
                continue

            if rows:
                await broadcast_state(st, {
                    "type":"ticks",
                    "source":st.source,
                    "file":st.name,
                    "fileId":st.id,
                    "rows":rows,
                    "total":st.last_rows,
                    "splTrd":spl,
                    "ts":now_ms(),
                })

            if amends:
                # Reuse the module's row-key function when possible.
                mod = TAS if st.source == "tas" else TAQ
                keyfn = mod.get("_row_key")
                await broadcast_state(st, {
                    "type":"amend",
                    "source":st.source,
                    "file":st.name,
                    "fileId":st.id,
                    "rows":[{
                        "key": keyfn(r) if keyfn else "",
                        "tradeId":r.get("tradeId"),"time":r.get("time"),"last":r.get("last"),
                        "trdIdDiff":r.get("trdIdDiff"),"seqNumDiff":r.get("seqNumDiff"),
                        "movesDiff":r.get("movesDiff"),
                    } for r in amends],
                    "ts":now_ms(),
                })

            # Give Excel and the event loop a small gap before accessing the
            # next workbook instead of hammering three COM ranges back-to-back.
            await asyncio.sleep(0.03)

        if cycle % 100 == 0:
            for ws in list(CLIENTS):
                source = CLIENT_PREFS.get(ws,{}).get("source")
                if not source:
                    continue
                st = selected_state(ws)
                await send(ws, {
                    "type":"heartbeat",
                    "source":source,
                    "file":st.name if st else None,
                    "files":{x.id:{"name":x.name,"rows":x.last_rows} for x in files_for(source)},
                    "clients":len(CLIENTS),
                    "ts":now_ms(),
                })


def _folder_excel_files(folder: str) -> list[str]:
    """Excel files visible in the selected Data_Files folder."""
    try:
        p = Path(folder)
        if not p.is_dir():
            return []
        out = []
        for f in p.iterdir():
            if not f.is_file():
                continue
            if f.name.startswith("~$"):
                continue
            if f.suffix.lower() not in (".xlsm", ".xlsx", ".xls"):
                continue
            out.append(str(f.resolve()))
        return sorted(out, key=lambda x: Path(x).name.lower())
    except Exception:
        return []


def _filename_source_hint(path: str) -> str | None:
    """Fast UI classification. Header detection still verifies on Connect."""
    n = Path(path).stem.lower()
    if "taq" in n:
        return "taq"
    if "tas" in n or "real_time_tas" in n or "realtime_tas" in n:
        return "tas"
    if "new_gcv" in n or "gcv1" in n or "new_gc" in n or n.startswith("gc"):
        return "cf"
    return None


def _files_for_dropdown(folder: str, source: str) -> list[str]:
    files = _folder_excel_files(folder)
    preferred, other = [], []
    for p in files:
        hint = _filename_source_hint(p)
        if hint == source:
            preferred.append(p)
        elif hint is None:
            other.append(p)
    # Put likely matches first, but still allow any workbook to be chosen.
    return preferred + [p for p in other if p not in preferred] + [
        p for p in files if p not in preferred and p not in other
    ]


def choose_initial_folder(cli_files: list[str], cli_folder: str | None = None) -> str:
    if cli_folder:
        return str(Path(cli_folder).resolve())
    if cli_files:
        return str(Path(clean_path(cli_files[0])).parent)
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(
            title="Select the Data_Files folder containing TAQ, TAS and NEW_GCv1"
        )
        root.destroy()
        return str(Path(chosen).resolve()) if chosen else ""
    except Exception as exc:
        log.error("Folder picker failed: %s", exc)
        return ""


# STARTUP_AUTO_RECONNECT_V4_2
_LAST_SOURCES_FILE = Path(__file__).resolve().with_name("orderflow_last_sources.json")


def _load_last_sources() -> dict:
    import json as _json
    try:
        if not _LAST_SOURCES_FILE.exists():
            return {}
        obj = _json.loads(_LAST_SOURCES_FILE.read_text(encoding="utf-8"))
        if not isinstance(obj, dict):
            return {}
        out = {}
        for src in ("taq", "tas", "cf"):
            p = obj.get(src)
            if isinstance(p, str) and p.strip():
                out[src] = clean_path(p)
        return out
    except Exception as exc:
        log.warning("[AUTO-RECONNECT] could not read %s: %s", _LAST_SOURCES_FILE.name, exc)
        return {}


def _save_last_sources(mapping: dict) -> None:
    import json as _json
    try:
        clean = {}
        for src in ("taq", "tas", "cf"):
            p = mapping.get(src)
            if isinstance(p, str) and p.strip():
                clean[src] = clean_path(p)
        tmp = _LAST_SOURCES_FILE.with_suffix(".json.tmp")
        tmp.write_text(_json.dumps(clean, indent=2), encoding="utf-8")
        tmp.replace(_LAST_SOURCES_FILE)
    except Exception as exc:
        log.warning("[AUTO-RECONNECT] could not save %s: %s", _LAST_SOURCES_FILE.name, exc)


def _remember_last_source(source: str, path: str) -> None:
    if source not in ("taq", "tas", "cf"):
        return
    data = _load_last_sources()
    data[source] = clean_path(path)
    _save_last_sources(data)
    log.info("[AUTO-RECONNECT] remembered %s -> %s", source.upper(), Path(path).name)


def _forget_last_source(source: str) -> None:
    if source not in ("taq", "tas", "cf"):
        return
    data = _load_last_sources()
    if source in data:
        data.pop(source, None)
        _save_last_sources(data)
        log.info("[AUTO-RECONNECT] forgot %s", source.upper())


def _startup_reconnect_paths() -> list[str]:
    data = _load_last_sources()
    paths = []
    for src in ("taq", "tas", "cf"):
        p = data.get(src)
        if not p:
            continue
        if Path(p).exists():
            paths.append(p)
        else:
            log.warning("[AUTO-RECONNECT] saved %s file no longer exists: %s", src.upper(), p)
    return paths


def register_one(path: str, forced_source: str | None = None) -> UnifiedState | None:
    path = clean_path(path)
    if not Path(path).exists():
        log.warning("Not found: %s", path)
        return None

    # AUTO_OPEN_CONNECTED_WORKBOOK_V2:
    # Source detection reads Excel headers, so open the workbook first.
    ensure_excel_open(path)

    detected, hdr = detect_source(path)
    source = forced_source or detected
    if source not in ("tas", "taq", "cf"):
        log.warning("Could not identify TAS/TAQ/CF format: %s", path)
        return None

    # If the workbook is open and the detected format disagrees with the chosen
    # slot, reject the selection instead of feeding the wrong parser.
    if detected and forced_source and detected != forced_source:
        raise ValueError(
            f"{Path(path).name} looks like {detected.upper()}, "
            f"not {SOURCE_LABELS.get(forced_source, forced_source)}."
        )

    # One active workbook per source from the Python source manager.
    # Replacing TAQ does not touch TAS or CF, etc.
    for sid, old_state in list(STATES.items()):
        if old_state.source == source:
            del STATES[sid]

    st = UnifiedState(path, source, hdr)
    STATES[st.id] = st
    _remember_last_source(source, path)
    log.info("[%s] selected %s (header row %s)", source.upper(), st.name, hdr or "?")

    try:
        st.seed()
        log.info("[%s] seeded %d rows", st.name, st.last_rows)
    except Exception as exc:
        # This is allowed: the selected workbook may not be open in Excel yet.
        log.warning("[%s] selected; waiting for/opening Excel connection: %s", st.name, exc)
    return st


def discover_open_workbooks():
    """Attach already-open Excel workbooks without requiring startup file paths.

    Manual source-manager choices remain authoritative. Auto-discovery only fills
    a source slot that is currently empty.
    """
    existing = {st.source for st in STATES.values()}
    added = []
    try:
        apps = list(xw.apps)
    except Exception:
        return added

    for app in apps:
        try:
            books = list(app.books)
        except Exception:
            continue
        for book in books:
            try:
                path = str(Path(book.fullname).resolve())
            except Exception:
                continue
            if not path or Path(path).name.startswith("~$"):
                continue
            try:
                source, _ = detect_source(path)
            except Exception:
                continue
            if source not in ("tas", "taq", "cf") or source in existing:
                continue
            try:
                st = register_one(path, source)
            except Exception as exc:
                log.debug("Auto-discovery failed for %s: %s", path, exc)
                continue
            if st:
                existing.add(source)
                added.append(st)
                log.info("AUTO ATTACHED [%s] %s", source.upper(), st.name)
    return added


def register_files(paths):
    """CLI compatibility: register every supplied path by auto-detected source."""
    for path in paths:
        try:
            register_one(path)
        except Exception as exc:
            log.warning("[%s] register failed: %s", Path(path).name, exc)


async def _send_all_source_lists(source: str):
    """Refresh the browser tab's workbook list after a Python dropdown change."""
    for ws in list(CLIENTS):
        pref = CLIENT_PREFS.get(ws, {})
        if pref.get("source") != source:
            continue

        items = public_file_list(source)
        current = pref.get("file_id")
        if not current or current not in STATES:
            pref["file_id"] = items[0]["id"] if items else None

        await send(ws, {
            "type": "source_files",
            "source": source,
            "files": items,
            "selected": pref.get("file_id"),
        })

        st = selected_state(ws)
        if st:
            await send_snapshot(ws, st)


async def control_loop():
    """Apply source-manager GUI commands without blocking WebSocket polling."""
    while True:
        await asyncio.sleep(0.10)
        while True:
            try:
                cmd = CONTROL_QUEUE.get_nowait()
            except queue.Empty:
                break

            action = cmd.get("action")
            if action == "connect":
                source = str(cmd.get("source") or "").lower()
                path = str(cmd.get("path") or "")
                try:
                    st = await excel_call(register_one, path, source)
                    if st is None:
                        raise RuntimeError("Workbook could not be registered.")
                    GUI_STATUS_QUEUE.put({
                        "source": source, "ok": True,
                        "text": f"CONNECTED  •  {st.name}  •  {st.last_rows:,} rows"
                    })
                    await _send_all_source_lists(source)
                except Exception as exc:
                    log.error("[%s] connect failed: %s", source.upper(), exc)
                    GUI_STATUS_QUEUE.put({
                        "source": source, "ok": False, "text": f"ERROR  •  {exc}"
                    })

            elif action == "disconnect":
                source = str(cmd.get("source") or "").lower()
                _forget_last_source(source)
                removed = []
                for sid, st in list(STATES.items()):
                    if st.source == source:
                        removed.append(st.name)
                        del STATES[sid]
                GUI_STATUS_QUEUE.put({
                    "source": source, "ok": True,
                    "text": "DISCONNECTED" if removed else "NOT CONNECTED"
                })
                await _send_all_source_lists(source)


def start_source_manager(initial_folder: str):
    """Persistent Tk source manager: TAQ, TAS, CF can each browse any workbook path."""
    def _run():
        import tkinter as tk
        from tkinter import ttk, filedialog, messagebox

        root = tk.Tk()
        root.title("OrderFlow — Unified xlwings Source Manager")
        root.geometry("1000x410")
        root.minsize(920, 380)

        style = ttk.Style(root)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        folder_var = tk.StringVar(value=initial_folder)
        source_vars = {k: tk.StringVar() for k in ("taq", "tas", "cf")}
        source_paths = {k: "" for k in ("taq", "tas", "cf")}
        status_vars = {k: tk.StringVar(value="NOT CONNECTED") for k in ("taq", "tas", "cf")}
        combos = {}

        outer = ttk.Frame(root, padding=12)
        outer.pack(fill="both", expand=True)

        ttk.Label(
            outer, text="UNIFIED XLWINGS — LIVE SOURCE MANAGER",
            font=("Segoe UI", 12, "bold")
        ).pack(anchor="w")

        ttk.Label(
            outer,
            text="Each source can browse its workbook independently. All connected sources stay live on ws://localhost:8766."
        ).pack(anchor="w", pady=(2, 12))

        folder_row = ttk.Frame(outer)
        folder_row.pack(fill="x", pady=(0, 12))
        ttk.Label(folder_row, text="Folder:", width=10).pack(side="left")
        ttk.Entry(folder_row, textvariable=folder_var).pack(side="left", fill="x", expand=True, padx=(0, 8))

        def browse_folder():
            chosen = filedialog.askdirectory(
                title="Optional: select a common folder containing TAQ, TAS and NEW_GCv1",
                initialdir=folder_var.get() or None
            )
            if chosen:
                folder_var.set(chosen)
                refresh()

        ttk.Button(folder_row, text="Browse Folder…", command=browse_folder).pack(side="left")
        ttk.Button(folder_row, text="↻ Refresh", command=lambda: refresh()).pack(side="left", padx=(6,0))

        grid = ttk.Frame(outer)
        grid.pack(fill="x")
        grid.columnconfigure(1, weight=1)

        def browse_source_file(source):
            current = source_paths.get(source, "").strip()
            initialdir = None

            if current:
                try:
                    initialdir = str(Path(current).parent)
                except Exception:
                    initialdir = None
            elif folder_var.get().strip():
                initialdir = folder_var.get().strip()

            chosen = filedialog.askopenfilename(
                title=f"Select {SOURCE_LABELS[source]} workbook",
                initialdir=initialdir or None,
                filetypes=[
                    ("Excel workbooks", "*.xlsm *.xlsx *.xls"),
                    ("All files", "*.*"),
                ],
            )
            if not chosen:
                return

            full = str(Path(chosen).resolve())
            name = Path(full).name
            source_paths[source] = full

            vals = list(combos[source]["values"])
            if name not in vals:
                combos[source]["values"] = [name] + vals

            source_vars[source].set(name)
            status_vars[source].set(f"SELECTED  •  {name}")

        def connect_source(source):
            path = source_paths.get(source, "").strip()

            if not path:
                raw = source_vars[source].get().strip()
                if not raw:
                    messagebox.showwarning(
                        "No workbook",
                        f"Use Browse File… or select a workbook for {SOURCE_LABELS[source]}."
                    )
                    return

                folder = folder_var.get().strip()
                if not folder:
                    messagebox.showwarning(
                        "No workbook path",
                        f"Use Browse File… to select the {SOURCE_LABELS[source]} workbook."
                    )
                    return

                path = str(Path(folder) / raw)

            if not Path(path).is_file():
                messagebox.showerror("Workbook not found", path)
                return

            status_vars[source].set("CONNECTING…")
            CONTROL_QUEUE.put({"action": "connect", "source": source, "path": path})

        def disconnect_source(source):
            CONTROL_QUEUE.put({"action": "disconnect", "source": source})

        def dropdown_selected(source):
            # A dropdown choice means use the current common-folder selection,
            # not a previous per-source Browse File path.
            source_paths[source] = ""

        for r, source in enumerate(("taq", "tas", "cf")):
            ttk.Label(grid, text=SOURCE_LABELS[source], width=16).grid(
                row=r, column=0, sticky="w", pady=7
            )

            cb = ttk.Combobox(grid, textvariable=source_vars[source], state="readonly")
            cb.grid(row=r, column=1, sticky="ew", padx=(0, 8), pady=7)
            combos[source] = cb
            cb.bind("<<ComboboxSelected>>", lambda _event, x=source: dropdown_selected(x))

            ttk.Button(
                grid, text="Browse File…",
                command=lambda x=source: browse_source_file(x)
            ).grid(row=r, column=2, padx=(0, 6), pady=7)

            ttk.Button(
                grid, text="Connect",
                command=lambda x=source: connect_source(x)
            ).grid(row=r, column=3, padx=(0, 6), pady=7)

            ttk.Button(
                grid, text="Disconnect",
                command=lambda x=source: disconnect_source(x)
            ).grid(row=r, column=4, pady=7)

            ttk.Label(grid, textvariable=status_vars[source], width=34).grid(
                row=r, column=5, sticky="w", padx=(10,0), pady=7
            )

        sep = ttk.Separator(outer)
        sep.pack(fill="x", pady=14)

        ttk.Label(
            outer,
            text="Recommended: open the selected workbook in Excel before Connect.\n"
                 "TAQ, TAS and GCV/CF may be in completely different folders."
        ).pack(anchor="w")

        def refresh():
            folder = folder_var.get().strip()

            for source in ("taq", "tas", "cf"):
                paths = _files_for_dropdown(folder, source) if folder else []
                names = [Path(x).name for x in paths]

                # Mirror startup-restored live state into the per-source picker.
                active_state = None
                for _sid, _st in list(STATES.items()):
                    if getattr(_st, "source", None) == source:
                        active_state = _st
                        break
                if active_state is not None:
                    source_paths[source] = active_state.path
                    status_vars[source].set(f"CONNECTED  •  {active_state.name}")

                selected_path = source_paths.get(source, "").strip()
                if selected_path and Path(selected_path).is_file():
                    selected_name = Path(selected_path).name
                    display_names = names[:]
                    if selected_name not in display_names:
                        display_names.insert(0, selected_name)
                    combos[source]["values"] = display_names
                    source_vars[source].set(selected_name)
                    continue

                combos[source]["values"] = names
                cur = source_vars[source].get()

                if cur not in names:
                    preferred = [
                        Path(x).name
                        for x in paths
                        if _filename_source_hint(x) == source
                    ]
                    source_vars[source].set(
                        preferred[0] if preferred else (names[0] if names else "")
                    )

        def pump_status():
            try:
                while True:
                    item = GUI_STATUS_QUEUE.get_nowait()
                    src = item.get("source")
                    if src in status_vars:
                        status_vars[src].set(item.get("text", ""))
            except queue.Empty:
                pass

            root.after(200, pump_status)

        refresh()
        pump_status()
        root.mainloop()

    t = threading.Thread(target=_run, name="OrderFlowSourceManager", daemon=True)
    t.start()
    return t


async def _bridge_tasks():
    await asyncio.gather(poll_loop(), control_loop())

async def run_server():
    kwargs={"ping_interval":30,"ping_timeout":10,"close_timeout":5,"max_size":MAX_WS_SIZE}
    try:
        async with websockets.serve(handler,WS_HOST,WS_PORT,**kwargs):
            log.info("Unified WebSocket ready: ws://%s:%d",WS_HOST,WS_PORT)
            await _bridge_tasks()
    except TypeError:
        async def v14(ws):
            await handler(ws)
        async with websockets.serve(v14,WS_HOST,WS_PORT,**kwargs):
            log.info("Unified WebSocket ready: ws://%s:%d",WS_HOST,WS_PORT)
            await _bridge_tasks()

async def main():
    global WS_PORT,POLL_INTERVAL
    ap=argparse.ArgumentParser(description="OrderFlow unified TAS/TAQ/CF xlwings bridge")
    ap.add_argument("files",nargs="*",help="Optional Excel workbooks to pre-connect")
    ap.add_argument("--folder",help="Folder containing TAQ/TAS/NEW_GCv1 workbooks")
    ap.add_argument("--port",type=int,default=8766)
    ap.add_argument("--interval",type=float,default=0.25)
    args=ap.parse_args()
    WS_PORT=args.port
    POLL_INTERVAL=max(0.05,args.interval)

    # STARTUP_AUTO_RECONNECT_V4_2
    # Priority: explicit CLI files -> remembered sources -> already-open workbooks.
    remembered = [] if args.files else _startup_reconnect_paths()

    folder = str(Path(args.folder).resolve()) if args.folder else (
        str(Path(clean_path(args.files[0])).parent) if args.files else (
            str(Path(remembered[0]).resolve().parent) if remembered else ""
        )
    )

    if args.files:
        explicit = [clean_path(x) for x in args.files]
        log.info("[AUTO-RECONNECT] explicit startup files=%d", len(explicit))
        await excel_call(register_files, explicit)
    elif remembered:
        log.info("[AUTO-RECONNECT] restoring %d saved source(s)", len(remembered))
        await excel_call(register_files, remembered)
    else:
        log.info("[AUTO-RECONNECT] no saved sources yet")

    # Attach any other supported workbooks already open in Excel.
    await excel_call(discover_open_workbooks)
    start_source_manager(folder)

    log.info("="*76)
    log.info("OrderFlow UNIFIED xlwings bridge — Source Manager")
    log.info("Folder: %s", folder or "(not selected — auto-discovery active)")
    log.info("Select TAQ, TAS and NEW_GCv1 independently from the persistent dropdowns.")
    log.info("One process / one port / three simultaneous live sources")
    log.info("WS: ws://%s:%d | poll %.2fs",WS_HOST,WS_PORT,POLL_INTERVAL)
    log.info("="*76)
    await run_server()

if __name__=="__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped.")
