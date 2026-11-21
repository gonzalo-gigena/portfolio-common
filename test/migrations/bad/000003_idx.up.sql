SET lock_timeout = '3s';
CREATE INDEX CONCURRENTLY t_name ON t (name);
