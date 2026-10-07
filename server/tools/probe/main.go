// 调试探针：查看 LiveKit 服务端视角的房间参与者与音频电平。
// 用法: go run ./tools/probe [房间名]
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

func main() {
	room := "演示房间"
	if len(os.Args) > 1 {
		room = os.Args[1]
	}
	host := envOr("LIVEKIT_HTTP_URL", "http://localhost:7880")
	key := envOr("LIVEKIT_API_KEY", "devkey")
	secret := envOr("LIVEKIT_API_SECRET", "devkeysecret")

	client := lksdk.NewRoomServiceClient(host, key, secret)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := client.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		fmt.Println("ERROR:", err)
		os.Exit(1)
	}
	if len(resp.Participants) == 0 {
		fmt.Println("(房间无参与者)")
		return
	}
	for _, p := range resp.Participants {
		// ParticipantInfo 不含实时电平（那是走信号推送的），
		// 这里主要看参与者在不在、轨道有没有发布
		fmt.Printf("%-24s sid=%-20s state=%-10s tracks=%d\n",
			p.Identity, p.Sid, p.State.String(), len(p.Tracks))
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
