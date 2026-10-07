// 调试机器人：以"麦克风"身份加入房间，持续发送带 RFC6464 电平扩展的 RTP 包，
// 用来验证 LiveKit 服务端的说话人检测与 ActiveSpeakers 广播链路。
// 载荷是无效 Opus 数据（没人需要听懂它），但包头电平是真实值 ——
// 服务端的说话人检测只依赖扩展头，与载荷能否解码无关。
//
// 用法: go run ./tools/audiobot [房间名] [运行秒数]
package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// toneProvider 提供 20ms 一帧的"伪音频"和恒定电平
type toneProvider struct{}

// RFC6464 电平：0=最响(0dBov)，127=静音。20 约等于 -20dB，属于明显的说话音量
var toneLevel uint8 = 20 // 可用 BOT_TONE_LEVEL 环境变量覆盖（模拟更响/更轻的说话人）

func (toneProvider) NextSample(context.Context) (media.Sample, error) {
	// 无效 Opus 载荷：80 字节占位数据（订阅端解码会静默丢弃，不影响本测试）
	return media.Sample{Data: make([]byte, 80), Duration: 20 * time.Millisecond}, nil
}
func (toneProvider) CurrentAudioLevel() uint8 { return toneLevel }
func (toneProvider) OnBind() error            { return nil }
func (toneProvider) OnUnbind() error          { return nil }
func (toneProvider) Close() error             { return nil }

func main() {
	if v := os.Getenv("BOT_TONE_LEVEL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 127 {
			toneLevel = uint8(n)
		}
	}
	roomName := "演示房间"
	if len(os.Args) > 1 {
		roomName = os.Args[1]
	}
	runSeconds := 30
	if len(os.Args) > 2 {
		fmt.Sscanf(os.Args[2], "%d", &runSeconds)
	}
	host := envOr("LIVEKIT_URL", "ws://localhost:7880")
	key := envOr("LIVEKIT_API_KEY", "devkey")
	secret := envOr("LIVEKIT_API_SECRET", "devkeysecret")

	// 服务端广播的说话人列表会回到这里 —— 打印出来即验证链路
	callback := &lksdk.RoomCallback{
		OnActiveSpeakersChanged: func(speakers []lksdk.Participant) {
			fmt.Printf("[speakers] %s\n", describeSpeakers(speakers))
		},
		OnParticipantConnected: func(p *lksdk.RemoteParticipant) {
			fmt.Printf("[join] %s\n", p.Identity())
		},
	}

	room, err := lksdk.ConnectToRoom(host, lksdk.ConnectInfo{
		APIKey:              key,
		APISecret:           secret,
		RoomName:            roomName,
		ParticipantName:     "朗读机器人",
		ParticipantIdentity: "audiobot",
	}, callback)
	if err != nil {
		fmt.Println("连接失败:", err)
		os.Exit(1)
	}
	fmt.Println("机器人已进房:", roomName)

	// 建一条 Opus 轨道（与浏览器发布麦克风时同规格），以麦克风源发布
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: 48000,
		Channels:  2,
	})
	if err != nil {
		fmt.Println("创建轨道失败:", err)
		os.Exit(1)
	}
	if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "bot-audio",
		Source: livekit.TrackSource_MICROPHONE,
	}); err != nil {
		fmt.Println("发布失败:", err)
		os.Exit(1)
	}
	// 等轨道协商完成（SDP bind）后才开始写样本
	for i := 0; i < 100 && !track.IsBound(); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if !track.IsBound() {
		fmt.Println("轨道未能在 10 秒内完成协商")
		os.Exit(1)
	}
	if err := track.StartWrite(toneProvider{}, nil); err != nil {
		fmt.Println("启动写入失败:", err)
		os.Exit(1)
	}
	fmt.Printf("正在以电平 %d 持续发言 %d 秒…\n", toneLevel, runSeconds)

	time.Sleep(time.Duration(runSeconds) * time.Second)
	room.Disconnect()
	fmt.Println("机器人已离房")
}

func describeSpeakers(speakers []lksdk.Participant) string {
	if len(speakers) == 0 {
		return "(无人说话)"
	}
	out := ""
	for _, s := range speakers {
		out += fmt.Sprintf("%s(level=%.2f) ", s.Identity(), s.AudioLevel())
	}
	return out
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
