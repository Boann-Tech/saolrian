// Package bootstrap seeds new user accounts with their profile row and the
// default meal slots.
package bootstrap

import (
	"log/slog"

	"github.com/pocketbase/pocketbase/core"
)

// defaultMealSlots are created for every new user.
var defaultMealSlots = []struct {
	Name  string
	Sort  int
	Pct   float64
}{
	{"Breakfast", 0, 25},
	{"Lunch", 1, 35},
	{"Dinner", 2, 25},
	{"Snacks", 3, 15},
}

// Register binds the users after-create hook.
func Register(app core.App) {
	app.OnRecordAfterCreateSuccess("users").BindFunc(func(e *core.RecordEvent) error {
		if err := seedUser(e.App, e.Record); err != nil {
			// don't fail the signup, just log; the user can be re-seeded
			// lazily by the summary route if needed.
			e.App.Logger().Error("failed to bootstrap user defaults",
				slog.String("userId", e.Record.Id), slog.String("error", err.Error()))
		}
		return e.Next()
	})
}

// seedUser creates the profile row and the default meal slots for the user.
func seedUser(app core.App, user *core.Record) error {
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return err
	}

	profileCol, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		return err
	}

	profile := core.NewRecord(profileCol)
	profile.Set("user", user.Id)
	profile.Set("activity_level", "moderate")
	profile.Set("tdee_formula", "mifflin")
	profile.Set("goal", "maintain")
	profile.Set("protein_pct", 30.0)
	profile.Set("carbs_pct", 40.0)
	profile.Set("fat_pct", 30.0)
	profile.Set("theme_accent", "#0f7a5f")
	profile.Set("goal_rate", 0.45)
	if err := app.Save(profile); err != nil {
		return err
	}

	slotsCol, err := app.FindCollectionByNameOrId("meal_slots")
	if err != nil {
		return err
	}
	for _, s := range defaultMealSlots {
		slot := core.NewRecord(slotsCol)
		slot.Set("user", user.Id)
		slot.Set("name", s.Name)
		slot.Set("sort_order", s.Sort)
		slot.Set("pct_allocation", s.Pct)
		if err := app.Save(slot); err != nil {
			return err
		}
	}

	_ = usersCol // kept only for clarity; the relation is stored by record id
	return nil
}
