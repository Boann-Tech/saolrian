package routes

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"

	"github.com/boanntech/saolrian/backend/internal/push"
)

type pushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// GET /api/saolrian/push/vapid-key
func pushVapidKeyHandler(e *core.RequestEvent) error {
	return e.JSON(http.StatusOK, map[string]any{
		"enabled":   push.Enabled(),
		"publicKey": push.PublicKey(),
	})
}

// POST /api/saolrian/push/subscribe
func pushSubscribeHandler(e *core.RequestEvent) error {
	var req pushSubscribeRequest
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("invalid JSON body", err)
	}
	if req.Endpoint == "" || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		return e.BadRequestError("endpoint and keys are required", nil)
	}

	uid := e.Auth.Id
	col, err := e.App.FindCollectionByNameOrId("push_subscriptions")
	if err != nil {
		return e.InternalServerError("failed to load push_subscriptions collection", err)
	}

	rec, err := e.App.FindFirstRecordByFilter(
		"push_subscriptions", "user = {:uid} && endpoint = {:endpoint}",
		map[string]any{"uid": uid, "endpoint": req.Endpoint},
	)
	if err != nil || rec == nil {
		rec = core.NewRecord(col)
		rec.Set("user", uid)
		rec.Set("endpoint", req.Endpoint)
	}
	rec.Set("p256dh", req.Keys.P256dh)
	rec.Set("auth", req.Keys.Auth)

	if err := e.App.Save(rec); err != nil {
		return e.InternalServerError("failed to save push subscription", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"ok": true})
}

// POST /api/saolrian/push/unsubscribe
func pushUnsubscribeHandler(e *core.RequestEvent) error {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("invalid JSON body", err)
	}

	uid := e.Auth.Id
	rec, err := e.App.FindFirstRecordByFilter(
		"push_subscriptions", "user = {:uid} && endpoint = {:endpoint}",
		map[string]any{"uid": uid, "endpoint": req.Endpoint},
	)
	if err == nil && rec != nil {
		_ = e.App.Delete(rec)
	}
	return e.JSON(http.StatusOK, map[string]any{"ok": true})
}
