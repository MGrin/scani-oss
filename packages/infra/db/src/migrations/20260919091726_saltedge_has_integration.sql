-- SC-1244. The connect flow now exists, so Salt Edge counts as an integration.
-- Whether a deployment actually offers it is decided by its keys: an unkeyed
-- provider carries no manifest and the integrations list never shows it.
UPDATE institutions SET has_integration = true WHERE website = 'https://www.saltedge.com';
