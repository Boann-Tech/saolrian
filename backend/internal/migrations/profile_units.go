// Display units. Storage stays metric everywhere — kg, cm, g, ml — so this
// field only ever changes how values are shown and typed. Absent means "use
// the locale default", which keeps every existing profile correct.
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
			&core.SelectField{Name: "units", Values: []string{"metric", "imperial"}, MaxSelect: 1},
		)

		return app.Save(profiles)
	}, func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return nil
		}
		profiles.Fields.RemoveByName("units")
		return app.Save(profiles)
	}, "saolrian_profile_units.go")
}
