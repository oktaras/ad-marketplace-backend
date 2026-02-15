ALTER TABLE "creatives"
ADD COLUMN "mediaMeta" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "creatives"
SET "mediaMeta" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'url', "mediaUrls"[idx],
        'type', COALESCE(("mediaTypes"[idx])::text, 'IMAGE'),
        'name', COALESCE(NULLIF(regexp_replace(split_part("mediaUrls"[idx], '?', 1), '^.*/', ''), ''), ('media-' || idx::text)),
        'provider', 'legacy'
      )
      ORDER BY idx
    )
    FROM generate_subscripts("mediaUrls", 1) AS idx
  ),
  '[]'::jsonb
);
