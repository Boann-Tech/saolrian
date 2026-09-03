# Saolrian backend — multi-stage build producing a static binary.
FROM golang:1.27-alpine AS build

WORKDIR /src

# cache deps first
COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /saolrian-backend .

# ---------------------------------------------------------------------
FROM alpine:3.20

RUN adduser -D -H -u 1000 saolrian

COPY --from=build /saolrian-backend /saolrian-backend

COPY backend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# root only long enough for the entrypoint to chown the volume,
# then it drops to the unprivileged 'saolrian' user.
WORKDIR /app

EXPOSE 8090

ENTRYPOINT ["/entrypoint.sh"]
