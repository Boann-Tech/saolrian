// Trends: three additive fields on profiles — which trend cards the user has
// enabled, and the provenance of the current calorie target.
//
// The provenance pair is what turns the observed-TDEE suggestion from a
// one-shot calculation into a loop: without it, an accepted target is
// indistinguishable from a number the user typed in once and forgot.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}

		profiles.Fields.Add(
			// Ordered array of enabled card ids. Presence means enabled and
			// position means display order, so one field covers visibility now
			// and drag-reorder later. Null or absent means "use the defaults",
			// which makes every existing profile correct with no backfill.
			&core.JSONField{Name: "trend_cards", MaxSize: 2000},
			// Where the current calorie_target came from. Empty means the user
			// typed it or it was never set.
			&core.SelectField{
				Name:      "calorie_target_source",
				Values:    []string{"manual", "observed"},
				MaxSelect: 1,
			},
			&core.DateField{Name: "calorie_target_set_at"},
		)

		return app.Save(profiles)
	}, func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return nil
		}
		profiles.Fields.RemoveByName("trend_cards")
		profiles.Fields.RemoveByName("calorie_target_source")
		profiles.Fields.RemoveByName("calorie_target_set_at")
		return app.Save(profiles)
	}, "saolrian_trend_cards.go")
}
