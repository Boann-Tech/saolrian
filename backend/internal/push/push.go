// Package push sends Web Push notifications to a user's stored browser
// subscriptions using VAPID authentication. When VAPID keys aren't
// configured (self-hosted deployments that skip push setup), every
// function here is a safe no-op — the import itself still works via
// in-app realtime updates and toasts.
package push

import (
	"encoding/json"
	"log/slog"
	"os"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/pocketbase/pocketbase/core"
)

type notificationPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Enabled reports whether VAPID keys are configured.
func Enabled() bool {
	return os.Getenv("VAPID_PUBLIC_KEY") != "" && os.Getenv("VAPID_PRIVATE_KEY") != ""
}

// PublicKey returns the configured VAPID public key, or "" if unset.
func PublicKey() string {
	return os.Getenv("VAPID_PUBLIC_KEY")
}

// NotifyUser sends title/body to every stored push subscription for uid.
// Failures are logged and otherwise ignored — a missed notification must
// never fail the import itself. A subscription the browser has revoked
// (404/410 response) is deleted so future sends don't keep retrying it.
func NotifyUser(app core.App, uid, title, body string) {
	if !Enabled() {
		return
	}

	subs, err := app.FindRecordsByFilter(
		"push_subscriptions", "user = {:uid}", "", 0, 0,
		map[string]any{"uid": uid},
	)
	if err != nil {
		app.Logger().Error("failed to load push subscriptions", slog.String("error", err.Error()))
		return
	}

	msg, err := json.Marshal(notificationPayload{Title: title, Body: body})
	if err != nil {
		return
	}

	for _, s := range subs {
		sub := &webpush.Subscription{
			Endpoint: s.GetString("endpoint"),
			Keys: webpush.Keys{
				P256dh: s.GetString("p256dh"),
				Auth:   s.GetString("auth"),
			},
		}
		resp, err := webpush.SendNotification(msg, sub, &webpush.Options{
			VAPIDPublicKey:  PublicKey(),
			VAPIDPrivateKey: os.Getenv("VAPID_PRIVATE_KEY"),
			TTL:             60,
		})
		if err != nil {
			app.Logger().Error("failed to send push notification",
				slog.String("userId", uid), slog.String("error", err.Error()))
			continue
		}
		resp.Body.Close()

		if resp.StatusCode == 404 || resp.StatusCode == 410 {
			_ = app.Delete(s)
		}
	}
}
