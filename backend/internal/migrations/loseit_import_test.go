package migrations_test

import (
	"testing"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/tests"
)

func TestLoseitImportMigration(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("failed to run app migrations: %v", err)
	}

	for _, name := range []string{"exercise_entries", "import_jobs", "push_subscriptions"} {
		if _, err := app.FindCollectionByNameOrId(name); err != nil {
			t.Errorf("expected collection %q to exist: %v", name, err)
		}
	}

	metrics, err := app.FindCollectionByNameOrId("daily_metrics")
	if err != nil {
		t.Fatalf("daily_metrics collection missing: %v", err)
	}
	for _, field := range []string{"sleep_hours", "body_fat_pct"} {
		if metrics.Fields.GetByName(field) == nil {
			t.Errorf("expected daily_metrics to have field %q", field)
		}
	}

	foods, err := app.FindCollectionByNameOrId("foods")
	if err != nil {
		t.Fatalf("foods collection missing: %v", err)
	}
	if foods.GetIndex("idx_foods_source_sourceId_loseit") == "" {
		t.Error("expected foods to have the loseit dedup index")
	}
}
