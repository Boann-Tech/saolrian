package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestPushVapidKeyHandlerHTTP_ReturnsExpectedShape drives
// pushVapidKeyHandler through a real HTTP request and checks the response
// shape reflects the current (unset-in-tests) VAPID configuration.
func TestPushVapidKeyHandlerHTTP_ReturnsExpectedShape(t *testing.T) {
	app, user := newTestAppWithUser(t)
	mux := newTestMux(t, app)

	t.Setenv("VAPID_PUBLIC_KEY", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")

	req := authedRequest(t, user, http.MethodGet, "/api/saolrian/push/vapid-key", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got struct {
		Enabled   bool   `json:"enabled"`
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("failed to decode response body %q: %v", rec.Body.String(), err)
	}
	if got.Enabled {
		t.Errorf("enabled = true, want false (VAPID env vars unset)")
	}
	if got.PublicKey != "" {
		t.Errorf("publicKey = %q, want empty", got.PublicKey)
	}
}

func subscribeRequestBody(endpoint string) []byte {
	body, _ := json.Marshal(map[string]any{
		"endpoint": endpoint,
		"keys": map[string]string{
			"p256dh": "p256dh-" + endpoint,
			"auth":   "auth-" + endpoint,
		},
	})
	return body
}

// TestPushSubscribeHandlerHTTP_ScopesToAuthenticatedUser is the core
// security-relevant property called out in the issue: pushSubscribeHandler
// must key every subscription off e.Auth.Id, never a client-supplied user
// id, so two different authenticated users subscribing must each get their
// own push_subscriptions row.
func TestPushSubscribeHandlerHTTP_ScopesToAuthenticatedUser(t *testing.T) {
	app, user1 := newTestAppWithUser(t)
	user2 := newTestUser(t, app, "push-test-2@example.com")
	mux := newTestMux(t, app)

	req1 := authedRequest(t, user1, http.MethodPost, "/api/saolrian/push/subscribe", subscribeRequestBody("https://push.example/ep1"))
	rec1 := httptest.NewRecorder()
	mux.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("user1 subscribe: status = %d, want %d; body = %s", rec1.Code, http.StatusOK, rec1.Body.String())
	}

	req2 := authedRequest(t, user2, http.MethodPost, "/api/saolrian/push/subscribe", subscribeRequestBody("https://push.example/ep2"))
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("user2 subscribe: status = %d, want %d; body = %s", rec2.Code, http.StatusOK, rec2.Body.String())
	}

	sub1, err := app.FindFirstRecordByFilter("push_subscriptions", "endpoint = {:ep}", map[string]any{"ep": "https://push.example/ep1"})
	if err != nil {
		t.Fatalf("user1's subscription not found: %v", err)
	}
	if got := sub1.GetString("user"); got != user1.Id {
		t.Errorf("ep1 subscription.user = %q, want %q", got, user1.Id)
	}

	sub2, err := app.FindFirstRecordByFilter("push_subscriptions", "endpoint = {:ep}", map[string]any{"ep": "https://push.example/ep2"})
	if err != nil {
		t.Fatalf("user2's subscription not found: %v", err)
	}
	if got := sub2.GetString("user"); got != user2.Id {
		t.Errorf("ep2 subscription.user = %q, want %q", got, user2.Id)
	}

	all, err := app.FindRecordsByFilter("push_subscriptions", "", "", 0, 0, nil)
	if err != nil {
		t.Fatalf("failed to list push_subscriptions: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected exactly 2 push_subscriptions rows total, got %d", len(all))
	}
}

// TestPushUnsubscribeHandlerHTTP_OnlyRemovesOwnRow is the two-user isolation
// test called out in the issue: user A unsubscribing from their own
// endpoint must never remove user B's row, even one with a similar/matching
// endpoint value, since the query must be scoped by e.Auth.Id.
func TestPushUnsubscribeHandlerHTTP_OnlyRemovesOwnRow(t *testing.T) {
	app, user1 := newTestAppWithUser(t)
	user2 := newTestUser(t, app, "push-test-2@example.com")
	mux := newTestMux(t, app)

	const sharedEndpoint = "https://push.example/shared-endpoint"

	// Both users subscribe using the *same* endpoint string (plausible if,
	// say, two accounts share a browser profile) — this is the scenario
	// that would catch a query missing the "user = {:uid}" filter.
	rec1 := httptest.NewRecorder()
	mux.ServeHTTP(rec1, authedRequest(t, user1, http.MethodPost, "/api/saolrian/push/subscribe", subscribeRequestBody(sharedEndpoint)))
	if rec1.Code != http.StatusOK {
		t.Fatalf("user1 subscribe: status = %d, want %d; body = %s", rec1.Code, http.StatusOK, rec1.Body.String())
	}

	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, authedRequest(t, user2, http.MethodPost, "/api/saolrian/push/subscribe", subscribeRequestBody(sharedEndpoint)))
	if rec2.Code != http.StatusOK {
		t.Fatalf("user2 subscribe: status = %d, want %d; body = %s", rec2.Code, http.StatusOK, rec2.Body.String())
	}

	before, err := app.FindRecordsByFilter("push_subscriptions", "endpoint = {:ep}", "", 0, 0, map[string]any{"ep": sharedEndpoint})
	if err != nil || len(before) != 2 {
		t.Fatalf("expected 2 rows sharing the endpoint before unsubscribe, got %d (err=%v)", len(before), err)
	}

	// user1 unsubscribes from the shared endpoint
	unsubBody, _ := json.Marshal(map[string]string{"endpoint": sharedEndpoint})
	recUnsub := httptest.NewRecorder()
	mux.ServeHTTP(recUnsub, authedRequest(t, user1, http.MethodPost, "/api/saolrian/push/unsubscribe", unsubBody))
	if recUnsub.Code != http.StatusOK {
		t.Fatalf("user1 unsubscribe: status = %d, want %d; body = %s", recUnsub.Code, http.StatusOK, recUnsub.Body.String())
	}

	after, err := app.FindRecordsByFilter("push_subscriptions", "endpoint = {:ep}", "", 0, 0, map[string]any{"ep": sharedEndpoint})
	if err != nil {
		t.Fatalf("failed to list remaining subscriptions: %v", err)
	}
	if len(after) != 1 {
		t.Fatalf("expected exactly 1 remaining subscription (user2's), got %d", len(after))
	}
	if got := after[0].GetString("user"); got != user2.Id {
		t.Errorf("remaining subscription.user = %q, want %q (user1's row should have been removed, not user2's)", got, user2.Id)
	}
}
