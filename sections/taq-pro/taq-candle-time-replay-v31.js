(function(){
"use strict";

if(window.__ITR_TAQ_CANDLE_TIME_REPLAY_V31__) return;
window.__ITR_TAQ_CANDLE_TIME_REPLAY_V31__ = true;
window.__ITR_TAQ_FULL_RANGE_RENDER_V311__ = true;
window.__ITR_TAQ_RENDER_FINAL_COMMIT_V312__ = true;

const S = window.__ITR_TAQ_CANDLE_V31_STATE__ || {
    rows: [],
    groups: [],
    seen: [],
    publishedRowCount: 0,
    groupIndex: 0,
    rowIndex: 0,

    timer: null,
    controller: null,
    generation: 0,

    running: false,
    paused: false,

    delay: 200,
    intervalSec: 60
};

window.__ITR_TAQ_CANDLE_V31_STATE__ = S;


function q(id){
    return document.getElementById(id);
}


function setStatus(text){
    const el = q("itr-db-replay-v3-status");
    if(el) el.textContent = String(text || "");
}


function pad(v){
    return String(v).padStart(2,"0");
}


function formatTime(ms){
    const d = new Date(ms);

    return (
        pad(d.getHours()) + ":" +
        pad(d.getMinutes()) + ":" +
        pad(d.getSeconds())
    );
}


function formatDate(ms){
    const d = new Date(ms);

    return (
        d.getFullYear() + "-" +
        pad(d.getMonth()+1) + "-" +
        pad(d.getDate())
    );
}


/* ============================================================
   RANGE
   ============================================================ */

function readRange(){

    const pairs = [
        ["dt-start","dt-end"],
        ["tr-start-dt","tr-end-dt"],
        ["tas-side-start","tas-side-end"]
    ];

    for(const pair of pairs){

        const s = q(pair[0]);
        const e = q(pair[1]);

        const start = s ? String(s.value || "").trim() : "";
        const end   = e ? String(e.value || "").trim() : "";

        if(start && end){
            return {start,end};
        }
    }

    return {start:"",end:""};
}


function localInputMs(value){

    const m = String(value || "").match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
    );

    if(!m) return NaN;

    return new Date(
        Number(m[1]),
        Number(m[2])-1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] || 0),
        0
    ).getTime();
}


/* ============================================================
   ROW TIMESTAMP
   ============================================================ */

function rowMs(r){

    if(!r) return 0;

    try{
        if(typeof _toAbsMs === "function"){
            const v = Number(_toAbsMs(r));
            if(v > 0) return v;
        }
    }catch(e){}

    if(Number(r._tsMs) > 0){
        return Number(r._tsMs);
    }

    const raw =
        r.ts ||
        r.Timestamp ||
        r.timestamp ||
        (
            r.date && r.time
                ? String(r.date) + "T" + String(r.time)
                : ""
        );

    const ms = Date.parse(raw);

    return Number.isFinite(ms) ? ms : 0;
}


/* ============================================================
   DATABASE RESPONSE
   ============================================================ */

function extractRows(payload){

    let list = [];

    if(Array.isArray(payload)){
        list = payload;
    }
    else if(payload && Array.isArray(payload.rows)){
        list = payload.rows;
    }
    else if(payload && Array.isArray(payload.data)){
        list = payload.data;
    }
    else if(payload && Array.isArray(payload.ticks)){
        list = payload.ticks;
    }

    list = list.map(function(item){

        if(
            item &&
            item.raw &&
            typeof item.raw === "object"
        ){
            const r = Object.assign({},item.raw);

            if(!r._tsMs && item.ts){
                const ms = Date.parse(item.ts);
                if(Number.isFinite(ms)){
                    r._tsMs = ms;
                }
            }

            return r;
        }

        return item;
    });

    if(typeof window._itrNormalizeDatabaseRows === "function"){
        return window._itrNormalizeDatabaseRows(list);
    }

    return list;
}


function apiBase(){

    try{
        if(
            typeof ITR_API_BASE !== "undefined" &&
            ITR_API_BASE
        ){
            return String(ITR_API_BASE).replace(/\/$/,"");
        }
    }catch(e){}

    return (
        window.location.protocol +
        "//" +
        window.location.hostname +
        ":4001"
    );
}


/* ============================================================
   MARKET-TIME CANDLE GROUPING

   1 minute:
   16:00:00 -> 16:00 candle
   16:01:00 -> 16:01 candle
   ...
   ============================================================ */

function getIntervalSec(){

    try{
        const v = Number(CFG.intervalSec);

        if(Number.isFinite(v) && v > 0){
            return v;
        }
    }catch(e){}

    return 60;
}


function buildGroups(rows,intervalSec){

    const bucketMs = intervalSec * 1000;
    const map = new Map();

    rows.forEach(function(r){

        const ms = rowMs(r);

        if(!ms) return;

        const start =
            Math.floor(ms / bucketMs) * bucketMs;

        let group = map.get(start);

        if(!group){

            group = {
                startMs: start,
                endMs: start + bucketMs,
                rows: []
            };

            map.set(start,group);
        }

        group.rows.push(r);
    });

    return Array.from(map.values())
        .sort(function(a,b){
            return a.startMs - b.startMs;
        });
}


/* ============================================================
   ANTI-FUTURE-LEAKAGE

   Shared application arrays contain ONLY history that replay
   has already reached.
   ============================================================ */

function publishSeenRows(reset){

    if(reset){
        S.publishedRowCount = 0;
        try{
            _allRawRows = [];
            window._allRawRows = _allRawRows;
        }catch(e){
            window._allRawRows = [];
        }

        try{
            _trAllRows = [];
            window._trAllRows = _trAllRows;
        }catch(e){
            window._trAllRows = [];
        }

        try{
            _dtFilteredRows = [];
            _dtActive = true;
            window._dtFilteredRows = _dtFilteredRows;
            window._dtActive = true;
        }catch(e){
            window._dtFilteredRows = [];
            window._dtActive = true;
        }

        try{
            _tlRows = [];
            window._tlRows = _tlRows;
        }catch(e){
            window._tlRows = [];
        }
    }

    const additions =
        S.seen.slice(S.publishedRowCount);

    if(!additions.length){
        return;
    }

    function append(target, rows){
        if(!Array.isArray(target)){
            target = [];
        }

        rows.forEach(function(row){
            target.push(row);
        });

        return target;
    }

    try{
        _allRawRows = append(_allRawRows,additions);
        window._allRawRows = _allRawRows;
    }catch(e){
        window._allRawRows = append(window._allRawRows,additions);
    }

    try{
        _trAllRows = append(_trAllRows,additions);
        window._trAllRows = _trAllRows;
    }catch(e){
        window._trAllRows = append(window._trAllRows,additions);
    }

    try{
        _dtFilteredRows = append(_dtFilteredRows,additions);
        _dtActive = true;
        window._dtFilteredRows = _dtFilteredRows;
        window._dtActive = true;
    }catch(e){
        window._dtFilteredRows = append(window._dtFilteredRows,additions);
        window._dtActive = true;
    }

    try{
        _tlRows = append(_tlRows,additions);
        window._tlRows = _tlRows;
    }catch(e){
        window._tlRows = append(window._tlRows,additions);
    }

    S.publishedRowCount = S.seen.length;
}


function syncHistoricalBars(){

    try{
        _trBars = _closedBars.slice();

        const n =
            typeof _maxBars === "function"
                ? _maxBars()
                : (
                    parseInt(
                        (q("bar-n") || {}).value,
                        10
                    ) || 10
                );

        _trOffset =
            Math.max(
                0,
                _trBars.length - n
            );

    }catch(e){}
}


/* ============================================================
   RENDER CURRENT MARKET STATE
   ============================================================ */

function renderCurrent(){

    try{
        if(typeof _rebuildDisplay === "function"){
            _rebuildDisplay();
        }
    }catch(e){
        console.warn("[TAQ V3.1] chart render:",e);
    }


    try{
        if(typeof csUpdateLast === "function"){
            csUpdateLast();
        }
    }catch(e){}

    try{
        if(typeof tasUpdateNav === "function"){
            tasUpdateNav();
        }
    }catch(e){}

    try{
        if(typeof _deltaFlipUpdate === "function"){
            _deltaFlipUpdate();
        }
    }catch(e){}


    /*
       Refresh only the currently visible heavy tab.
       Other tabs use the seen-only arrays when opened.
    */
    try{

        const tab =
            (
                document.querySelector(".main-tab.active") || {}
            ).dataset?.tab || "";

        if(
            tab === "summary" &&
            typeof sumRender === "function"
        ){
            sumRender();
        }

        else if(
            tab === "levels" &&
            typeof aggBuild === "function"
        ){
            aggBuild();
        }

        else if(
            tab === "lagr" &&
            typeof laRebuild === "function"
        ){
            laRebuild();
        }

        else if(
            tab === "dfpairs" &&
            typeof dfpRender === "function"
        ){
            dfpRender();
        }

        else if(
            tab === "tradelog" &&
            typeof tlRender === "function"
        ){
            tlRender();
        }

    }catch(e){}


    /*
       ========================================================
       V3.1.2 FINAL FULL-RANGE RENDER COMMIT

       This MUST be the final operation in renderCurrent().

       Normal TAQ rendering respects bar-n/_maxBars.
       During historical replay that reduced:

           _closedBars = 240
           _trBars     = 240
           R.bars      = 10

       Historical replay must preserve all completed candles.

       Database rows, candle construction and bar-n are untouched.
       ========================================================
    */

    const commitHistoricalFullRange = function(){

        try{

            if(
                typeof R !== "undefined" &&
                R &&
                typeof _closedBars !== "undefined" &&
                Array.isArray(_closedBars) &&
                _closedBars.length
            ){

                const needsResize =
                    !Array.isArray(R.bars) ||
                    R.bars.length !== _closedBars.length;

                R.bars = _closedBars.slice();


                if(
                    needsResize &&
                    typeof R.resize === "function"
                ){
                    R.resize();
                }


                if(typeof R.draw === "function"){
                    R.draw();
                }

            }

        }catch(err){

            console.warn(
                "[TAQ V3.1.2] final full-range commit:",
                err
            );
        }

    };


    /*
       Commit immediately AFTER all synchronous helper renders.
    */
    commitHistoricalFullRange();


    /*
       Commit once more on the next browser paint.
       This catches a synchronous late repaint that previously
       restored bar-n = 10.
    */
    try{

        requestAnimationFrame(function(){

            commitHistoricalFullRange();


            try{

                const hs = q("hscroll");

                if(hs){
                    hs.scrollLeft = hs.scrollWidth;
                }

            }catch(e){}

        });

    }catch(e){}

}


/* ============================================================
   RESET DISPLAY FOR NEW HISTORICAL REPLAY
   ============================================================ */

function resetChart(){

    try{
        if(
            typeof _rpTimer !== "undefined" &&
            _rpTimer
        ){
            clearInterval(_rpTimer);
            _rpTimer = null;
        }
    }catch(e){}

    try{
        _closedBars = [];
    }catch(e){
        window._closedBars = [];
    }

    try{
        _openBarTicks = [];
    }catch(e){
        window._openBarTicks = [];
    }

    try{
        _trBars = [];
        _trOffset = 0;
    }catch(e){}

    try{
        _rpRows = S.rows.slice();
        _rpIdx = 0;
        _rpSumRows = [];
        _rpTotalRows = S.rows.length;
        _rpActive = true;
        _rpPaused = false;
    }catch(e){}

    S.seen = [];
    S.rowIndex = 0;
    S.groupIndex = 0;

    publishSeenRows(true);

    try{
        if(typeof _lastBarCount !== "undefined"){
            _lastBarCount = -1;
        }
    }catch(e){}

    if(!R && typeof Renderer === "function"){
        R = new Renderer([]);
        if(typeof syncMode === "function"){
            syncMode(CFG.mode);
        }
    }

    try{
        if(R){

            R.bars = [];

            if(typeof R.resize === "function"){
                R.resize();
            }

            if(typeof R.draw === "function"){
                R.draw();
            }
        }
    }catch(e){}

    renderCurrent();
}


/* ============================================================
   ONE REAL MARKET-TIME CANDLE
   ============================================================ */

function stepOneCandle(){

    if(!S.running || S.paused){
        return;
    }

    if(S.groupIndex >= S.groups.length){
        finishReplay();
        return;
    }

    const g = S.groups[S.groupIndex];

    let bar = null;

    try{
        bar = _ticksToBar(g.rows.slice());
    }
    catch(e){
        console.error(
            "[TAQ V3.1] _ticksToBar failed:",
            e
        );
    }


    if(bar){

        bar._tsMs   = g.startMs;
        bar.date    = formatDate(g.startMs);
        bar.time    = formatTime(g.startMs);
        bar.timeEnd = formatTime(g.endMs);
        bar.ticks   = g.rows.slice();

        let previousCum = 0;

        try{
            if(_closedBars.length){
                previousCum =
                    Number(
                        _closedBars[
                            _closedBars.length - 1
                        ].cumD
                    ) || 0;
            }
        }catch(e){}

        bar.cumD =
            previousCum +
            (Number(bar.delta) || 0);

        try{
            _closedBars.push(bar);
        }catch(e){
            window._closedBars.push(bar);
        }
    }


    g.rows.forEach(function(row){
        S.seen.push(row);
    });

    S.rowIndex += g.rows.length;


    try{
        _rpSumRows = g.rows.slice();
        _rpIdx = S.rowIndex;
        _rpActive = true;
        _rpPaused = false;
    }catch(e){}


    publishSeenRows();
    syncHistoricalBars();
    renderCurrent();


    S.groupIndex++;


    setStatus(
        "CANDLE " +
        S.groupIndex +
        "/" +
        S.groups.length +
        " · " +
        formatTime(g.startMs) +
        " → " +
        formatTime(g.endMs) +
        " · " +
        S.rowIndex.toLocaleString() +
        "/" +
        S.rows.length.toLocaleString() +
        " rows"
    );


    try{
        window.dispatchEvent(
            new CustomEvent(
                "orderflow:historical-candle",
                {
                    detail:{
                        index: S.groupIndex,
                        total: S.groups.length,
                        startMs: g.startMs,
                        endMs: g.endMs,
                        rows: g.rows.length,
                        bar: bar
                    }
                }
            )
        );
    }catch(e){}


    if(S.groupIndex >= S.groups.length){
        finishReplay();
    }
}


/* ============================================================
   TIMER
   ============================================================ */

function schedule(){

    if(S.timer){
        clearInterval(S.timer);
        S.timer = null;
    }

    S.timer =
        setInterval(
            stepOneCandle,
            S.delay
        );
}


function pauseResume(){

    if(!S.running){

        setStatus(
            "Replay is not running"
        );

        return;
    }


    if(!S.paused){

        S.paused = true;

        if(S.timer){
            clearInterval(S.timer);
            S.timer = null;
        }

        try{
            _rpPaused = true;
        }catch(e){}

        setStatus(
            "PAUSED · candle " +
            S.groupIndex +
            "/" +
            S.groups.length
        );

    }
    else{

        S.paused = false;

        try{
            _rpPaused = false;
        }catch(e){}

        setStatus(
            "RESUMED · candle " +
            S.groupIndex +
            "/" +
            S.groups.length
        );

        schedule();
    }
}


/* ============================================================
   STOP
   ============================================================ */

function stopReplay(){

    if(S.timer){
        clearInterval(S.timer);
        S.timer = null;
    }

    try{
        if(
            typeof _rpTimer !== "undefined" &&
            _rpTimer
        ){
            clearInterval(_rpTimer);
            _rpTimer = null;
        }
    }catch(e){}


    if(S.controller){

        try{
            S.controller.abort();
        }catch(e){}

        S.controller = null;
    }


    S.running = false;
    S.paused = false;


    try{
        _rpActive = false;
        _rpPaused = false;
    }catch(e){}


    setStatus(
        "STOPPED · candle " +
        S.groupIndex +
        "/" +
        S.groups.length +
        " · chart preserved"
    );
}


/* ============================================================
   FINISH
   ============================================================ */

function finishReplay(){

    if(S.timer){
        clearInterval(S.timer);
        S.timer = null;
    }

    S.running = false;
    S.paused = false;

    try{
        _rpActive = false;
        _rpPaused = false;
    }catch(e){}

    publishSeenRows();
    syncHistoricalBars();
    renderCurrent();


    if(S.groups.length){

        setStatus(
            "COMPLETE · " +
            S.groups.length +
            " candles · " +
            S.rows.length.toLocaleString() +
            " rows · " +
            formatTime(S.groups[0].startMs) +
            " → " +
            formatTime(
                S.groups[
                    S.groups.length - 1
                ].endMs
            )
        );
    }
}


/* ============================================================
   START DATABASE MARKET-TIME REPLAY
   ============================================================ */

async function startReplay(){

    const range = readRange();

    const startMs =
        localInputMs(range.start);

    const endMs =
        localInputMs(range.end);


    if(
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs
    ){
        setStatus(
            "Invalid START / END range"
        );

        return false;
    }


    stopReplay();


    const generation =
        ++S.generation;


    const controller =
        new AbortController();

    S.controller =
        controller;


    setStatus(
        "LOADING · " +
        range.start.replace("T"," ") +
        " → " +
        range.end.replace("T"," ")
    );


    const section =
        (
            typeof ITR_SECTION_ID !== "undefined" &&
            ITR_SECTION_ID
        )
        ? ITR_SECTION_ID
        : "taq-pro";


    const url =
        apiBase() +
        "/api/ticks/" +
        encodeURIComponent(section) +
        "?start=" +
        encodeURIComponent(
            new Date(startMs).toISOString()
        ) +
        "&end=" +
        encodeURIComponent(
            new Date(endMs).toISOString()
        ) +
        "&symbol=" +
        encodeURIComponent(
            String((typeof CFG !== "undefined" && CFG.symbol) || "XAUUSD").trim().toUpperCase()
        );


    try{

        const response =
            await fetch(
                url,
                {
                    method:"GET",
                    signal:controller.signal,
                    cache:"no-store"
                }
            );


        if(!response.ok){

            throw new Error(
                "HTTP " +
                response.status +
                " " +
                response.statusText
            );
        }


        const payload =
            await response.json();


        if(
            controller.signal.aborted ||
            generation !== S.generation
        ){
            return false;
        }


        let rows =
            extractRows(payload);


        /*
           START inclusive
           END exclusive

           16:00 -> 20:00 means:
           16:00:00 ... 19:59:59.xxx
        */
        rows = rows.filter(function(r){

            const ms = rowMs(r);

            return (
                ms >= startMs &&
                ms < endMs
            );
        });


        rows.sort(function(a,b){
            return rowMs(a) - rowMs(b);
        });

        if(typeof window.applyCorrectDiffs === "function"){
            rows = window.applyCorrectDiffs(rows) || rows;
        }


        if(!rows.length){

            setStatus(
                "NO DATA · selected range contains 0 rows"
            );

            return false;
        }


        const sec =
            getIntervalSec();


        const groups =
            buildGroups(
                rows,
                sec
            );


        if(!groups.length){

            setStatus(
                "NO CANDLES · timestamps could not be grouped"
            );

            return false;
        }


        S.rows =
            rows.slice();

        S.groups =
            groups;

        S.intervalSec =
            sec;

        S.groupIndex = 0;
        S.rowIndex = 0;
        S.seen = [];

        S.running = true;
        S.paused = false;


        resetChart();


        setStatus(
            "READY · " +
            groups.length +
            " market-time candles · " +
            rows.length.toLocaleString() +
            " rows · " +
            formatTime(groups[0].startMs) +
            " → " +
            formatTime(
                groups[
                    groups.length-1
                ].endMs
            )
        );


        /*
           First candle immediately.
        */
        stepOneCandle();


        if(S.running){
            schedule();
        }


        return true;

    }
    catch(err){

        if(
            controller.signal.aborted ||
            err.name === "AbortError"
        ){
            return false;
        }


        console.error(
            "[TAQ CANDLE TIME V3.1]",
            err
        );


        setStatus(
            "REPLAY ERROR · " +
            (
                err &&
                err.message
                    ? err.message
                    : String(err)
            )
        );


        return false;
    }
    finally{

        if(generation === S.generation){
            S.controller = null;
        }
    }
}


/* ============================================================
   REMOVE V3 BUTTON HANDLERS AND INSTALL V3.1 HANDLERS
   ============================================================ */

function replaceButton(id,handler){

    const old = q(id);

    if(!old) return null;


    const fresh =
        old.cloneNode(true);


    old.replaceWith(fresh);


    fresh.addEventListener(
        "click",
        function(e){

            e.preventDefault();
            e.stopPropagation();

            handler();
        }
    );


    return fresh;
}


function installControls(){

    const panel =
        q("itr-db-replay-v3-panel");

    if(!panel){
        return false;
    }


    if(panel.dataset.v31Installed === "1"){
        return true;
    }


    panel.dataset.v31Installed = "1";


    replaceButton(
        "itr-db-replay-v3-play",
        startReplay
    );


    replaceButton(
        "itr-db-replay-v3-pause",
        pauseResume
    );


    replaceButton(
        "itr-db-replay-v3-stop",
        stopReplay
    );


    const oldSpeed =
        q("itr-db-replay-v3-speed");


    if(oldSpeed){

        const speed =
            oldSpeed.cloneNode(false);


        speed.id =
            "itr-db-replay-v3-speed";


        speed.innerHTML =
            '<option value="1000">1 candle/sec</option>' +
            '<option value="500">2 candles/sec</option>' +
            '<option value="200" selected>5 candles/sec</option>' +
            '<option value="100">10 candles/sec</option>' +
            '<option value="50">20 candles/sec</option>';


        oldSpeed.replaceWith(speed);


        speed.addEventListener(
            "change",
            function(){

                S.delay =
                    Math.max(
                        30,
                        Number(speed.value) || 200
                    );


                if(
                    S.running &&
                    !S.paused
                ){
                    schedule();
                }
            }
        );
    }


    const label =
        panel.querySelector(
            ".itr-rp-v3-speed-row span"
        );


    if(label){
        label.textContent =
            "Replay speed";
    }


    setStatus(
        "V3.1 ready · candle-by-candle market-time replay"
    );


    return true;
}


/* ============================================================
   RANGE CHANGE = CURRENT REPLAY INVALID
   ============================================================ */

function wireRangeChanges(){

    [
        "dt-start",
        "dt-end",
        "tr-start-dt",
        "tr-end-dt",
        "tas-side-start",
        "tas-side-end"
    ].forEach(function(id){

        const el = q(id);

        if(
            !el ||
            el.dataset.itrV31Range === "1"
        ){
            return;
        }


        el.dataset.itrV31Range = "1";


        el.addEventListener(
            "change",
            function(){

                ++S.generation;

                if(
                    S.running ||
                    S.controller
                ){
                    stopReplay();
                }


                setStatus(
                    "Range changed · press REPLAY RANGE"
                );
            }
        );
    });
}


/* ============================================================
   PUBLIC API
   ============================================================ */

window.itrReplaySelectedDatabaseRange =
    startReplay;

window.itrPauseDatabaseCandleReplay =
    pauseResume;

window.itrStopDatabaseCandleReplay =
    stopReplay;


/* ============================================================
   INSTALL AFTER V3 PANEL EXISTS
   ============================================================ */

let tries = 0;

const installer =
    setInterval(
        function(){

            tries++;

            const ok =
                installControls();

            wireRangeChanges();


            if(ok || tries > 100){
                clearInterval(installer);
            }

        },
        100
    );

})();
