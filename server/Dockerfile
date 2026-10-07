# syntax=docker/dockerfile:1
# voice-rooms Go 后端镜像：两阶段构建，产物为静态二进制（CGO 关闭，
# modernc.org/sqlite 是纯 Go 实现，不依赖 glibc）
FROM golang:1.26-alpine AS build
WORKDIR /src
# 先拷依赖清单单独下载：go.mod/go.sum 不变时走缓存，改代码不用重新拉依赖
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/voice-rooms .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
	&& adduser -D -H -s /sbin/nologin voicerooms \
	&& mkdir -p /data && chown voicerooms /data
COPY --from=build /out/voice-rooms /usr/local/bin/voice-rooms
# 账号库固定放 /data/auth.db（compose 挂 named volume 持久化）
ENV AUTH_DB=/data/auth.db
USER voicerooms
EXPOSE 8080
ENTRYPOINT ["voice-rooms"]
