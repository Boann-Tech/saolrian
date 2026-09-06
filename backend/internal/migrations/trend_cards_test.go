package migrations_test

import (
	"slices"
	"testing"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/core"
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

	// Check trend_cards is a JSONField
	trendCardsField := profiles.Fields.GetByName("trend_cards")
	if trendCardsField == nil {
		t.Errorf("profiles.trend_cards field missing")
	} else if jsonField, ok := trendCardsField.(*core.JSONField); !ok {
		t.Errorf("profiles.trend_cards is not a JSONField, got %T", trendCardsField)
	} else if jsonField.Type() != "json" {
		t.Errorf("profiles.trend_cards type should be 'json', got %q", jsonField.Type())
	}

	// Check calorie_target_source is a SelectField with correct configuration
	sourceField := profiles.Fields.GetByName("calorie_target_source")
	if sourceField == nil {
		t.Errorf("profiles.calorie_target_source field missing")
	} else if selectField, ok := sourceField.(*core.SelectField); !ok {
		t.Errorf("profiles.calorie_target_source is not a SelectField, got %T", sourceField)
	} else {
		if selectField.Type() != "select" {
			t.Errorf("profiles.calorie_target_source type should be 'select', got %q", selectField.Type())
		}
		expectedValues := []string{"manual", "observed"}
		if !slices.Equal(selectField.Values, expectedValues) {
			t.Errorf("profiles.calorie_target_source values should be %v, got %v", expectedValues, selectField.Values)
		}
		if selectField.MaxSelect != 1 {
			t.Errorf("profiles.calorie_target_source MaxSelect should be 1, got %d", selectField.MaxSelect)
		}
	}

	// Check calorie_target_set_at is a DateField
	setAtField := profiles.Fields.GetByName("calorie_target_set_at")
	if setAtField == nil {
		t.Errorf("profiles.calorie_target_set_at field missing")
	} else if dateField, ok := setAtField.(*core.DateField); !ok {
		t.Errorf("profiles.calorie_target_set_at is not a DateField, got %T", setAtField)
	} else if dateField.Type() != "date" {
		t.Errorf("profiles.calorie_target_set_at type should be 'date', got %q", dateField.Type())
	}
}
