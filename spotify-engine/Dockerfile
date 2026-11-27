FROM rust:1-bookworm AS build

WORKDIR /src

# IPv6 to index.crates.io (Fastly) fails from build containers, and Cargo's
# HTTP/2 client then never gets past "Updating crates.io index".
RUN echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf
ENV CARGO_HTTP_MULTIPLEXING=false \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/spotify-engine /usr/local/bin/spotify-engine

ENV SPOTIFY_CACHE=/var/lib/spotify-cache \
    ENGINE_HTTP_ADDR=0.0.0.0:8090 \
    ENGINE_PCM_ADDR=0.0.0.0:8091 \
    RUST_LOG=info

EXPOSE 8090 8091

CMD ["spotify-engine"]
