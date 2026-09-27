
UPDATE user_jobs
   SET dead_at = NULL,
       failure_reason = NULL,
       updated_at = now()
 WHERE state = 'completed'
   AND dead_at IS NOT NULL;
