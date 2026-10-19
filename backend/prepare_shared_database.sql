-- Run this once in pgAdmin's Query Tool connected to itr_market_data
-- as postgres (or another database administrator).
--
-- The replay service can read shared market history but cannot modify it.
-- Its own imports and analysis records live in the replay_v31 schema.

GRANT CONNECT ON DATABASE itr_market_data TO orderflow_app;
CREATE SCHEMA IF NOT EXISTS replay_v31 AUTHORIZATION orderflow_app;
GRANT USAGE, CREATE ON SCHEMA replay_v31 TO orderflow_app;
GRANT SELECT ON TABLE public.itr_market_ticks TO orderflow_app;
