package push

import "testing"

func TestEnabled_FalseWhenVapidUnset(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")
	if Enabled() {
		t.Error("expected Enabled() to be false when VAPID env vars are unset")
	}
}

func TestEnabled_TrueWhenVapidSet(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "pub")
	t.Setenv("VAPID_PRIVATE_KEY", "priv")
	if !Enabled() {
		t.Error("expected Enabled() to be true when both VAPID env vars are set")
	}
}
