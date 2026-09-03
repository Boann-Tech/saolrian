# Saolrian backend — multi-stage build producing a static binary.
FROM golang:1.24-alpine AS build

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

USER saolrian
WORKDIR /app

EXPOSE 8090

CMD ["/saolrian-backend", "serve", "--http", "0.0.0.0:8090", "--dir", "/app/pb_data"]
