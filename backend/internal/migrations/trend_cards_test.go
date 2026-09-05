package migrations_test

import (
	"testing"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/tests"
)

func TestTrendFieldsExistOnProfiles(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	profiles, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		t.Fatalf("profiles collection missing: %v", err)
	}

	for _, name := range []string{"trend_cards", "calorie_target_source", "calorie_target_set_at"} {
		if profiles.Fields.GetByName(name) == nil {
			t.Errorf("profiles.%s field missing", name)
		}
	}
}
