# data branch

This is an orphan branch auto-rebuilt by `.github/workflows/scrape.yml`.
Contents:

- `data/jobs.json.gz` — gzipped snapshot of Singapore job listings
  from MyCareersFuture, JobStreet, and careers.gov.sg, deduped and
  normalized. Client decompresses on the fly via DecompressionStream.
- `data/meta.json` — small companion file with generation timestamp
  and size metadata. Cheap to fetch for freshness badges.
- `data/merges.md` — human-readable audit log of every merge the
  dedupe pass performed during this run.

The branch is force-recreated on every scrape run, so git history is
always exactly one commit deep.
