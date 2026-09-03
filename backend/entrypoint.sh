#!/bin/sh
# Saolrian entrypoint: ensure the data dir is writable by the app user,
# then drop privileges and start the server.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/pb_data
  chown -R saolrian:saolrian /app/pb_data
  exec su saolrian -s /bin/sh -c \
    "/saolrian-backend serve --http 0.0.0.0:8090 --dir /app/pb_data"
fi

exec /saolrian-backend serve --http 0.0.0.0:8090 --dir /app/pb_data