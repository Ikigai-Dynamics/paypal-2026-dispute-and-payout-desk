FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY fixtures ./fixtures
RUN cargo build --release --locked

FROM debian:stable-slim
COPY --from=build /src/target/release/decide /usr/local/bin/decide
ENV PORT=8080
EXPOSE 8080
CMD ["decide"]
