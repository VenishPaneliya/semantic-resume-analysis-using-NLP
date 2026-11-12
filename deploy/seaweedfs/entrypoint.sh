#!/bin/sh
# Writes the SeaweedFS S3 identities from environment variables, then starts SeaweedFS with its usual
# entrypoint. Keeps credentials out of git (they come from .env / the production env file).
#
#   app   -> S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY: Read, Write (put + delete) and List on S3_BUCKET only.
#            This is everything the application does: put/get/head/delete object, list + batch delete.
#   admin -> S3_ADMIN_ACCESS_KEY_ID / S3_ADMIN_SECRET_ACCESS_KEY: creates the bucket (s3-init) and is
#            meant for operators; the application never receives it.
# Any of these may instead be given as a file (Docker secrets): S3_ADMIN_SECRET_ACCESS_KEY_FILE=/run/secrets/...
set -eu

: "${S3_BUCKET:=resume-intelligence-private}"
for v in S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_ADMIN_ACCESS_KEY_ID S3_ADMIN_SECRET_ACCESS_KEY S3_BUCKET; do
  eval "file=\${${v}_FILE:-}"
  if [ -n "$file" ]; then
    val=$(tr -d '\r\n' < "$file")
    eval "$v=\$val"
  fi
  eval "val=\${$v:-}"
  # also guarantees the values can be pasted into JSON below without escaping
  case "$val" in
    "" ) echo "seaweedfs-entrypoint: $v is not set" >&2; exit 1 ;;
    *[!A-Za-z0-9._-]* ) echo "seaweedfs-entrypoint: $v may only contain A-Z a-z 0-9 . _ -" >&2; exit 1 ;;
  esac
done
if [ "$S3_ACCESS_KEY_ID" = "$S3_ADMIN_ACCESS_KEY_ID" ]; then
  echo "seaweedfs-entrypoint: the app and admin access keys must differ" >&2; exit 1
fi

umask 077
cat > /tmp/s3.json <<JSON
{
  "identities": [
    {
      "name": "admin",
      "credentials": [{ "accessKey": "$S3_ADMIN_ACCESS_KEY_ID", "secretKey": "$S3_ADMIN_SECRET_ACCESS_KEY" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    },
    {
      "name": "app",
      "credentials": [{ "accessKey": "$S3_ACCESS_KEY_ID", "secretKey": "$S3_SECRET_ACCESS_KEY" }],
      "actions": ["Read:$S3_BUCKET", "Write:$S3_BUCKET", "List:$S3_BUCKET"]
    }
  ]
}
JSON
exec /entrypoint.sh "$@"
