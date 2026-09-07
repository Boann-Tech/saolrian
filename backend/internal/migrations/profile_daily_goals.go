// Daily goals: the water and step targets shown on the dashboard were literals
// in the frontend markup (2000 ml / 10000 steps) with nowhere to change them.
// Two additive fields make them the user's own. Zero/absent means "use the
// default", so every existing profile stays correct with no backfill.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}

		profiles.Fields.Add(
			&core.NumberField{Name: "water_goal_ml", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "steps_goal", Min: types.Pointer(0.0)},
		)

		return app.Save(profiles)
	}, func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return nil
		}
		profiles.Fields.RemoveByName("water_goal_ml")
		profiles.Fields.RemoveByName("steps_goal")
		return app.Save(profiles)
	}, "saolrian_profile_daily_goals.go")
}
