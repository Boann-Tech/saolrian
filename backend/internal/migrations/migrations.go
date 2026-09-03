// Package migrations registers the Saolrian app collections with PocketBase.
//
// All collections are user-scoped: every rule requires that the record's
// `user` field matches the authenticated user, so users can only touch
// their own rows.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// profiles
		// ---------------------------------------------------------------
		profiles := core.NewBaseCollection("profiles")
		profiles.ListRule = types.Pointer(ownerRule)
		profiles.ViewRule = types.Pointer(ownerRule)
		profiles.CreateRule = types.Pointer(ownerRule)
		profiles.UpdateRule = types.Pointer(ownerRule)
		profiles.DeleteRule = types.Pointer(ownerRule)

		profiles.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "name"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
			&core.NumberField{Name: "height_cm"},
			&core.NumberField{Name: "birth_year"},
			&core.SelectField{Name: "sex", Values: []string{"male", "female", "other"}, MaxSelect: 1},
			&core.SelectField{Name: "activity_level", Values: []string{"sedentary", "light", "moderate", "very", "extreme"}, MaxSelect: 1},
			&core.NumberField{Name: "body_fat_pct"},
			&core.SelectField{Name: "tdee_formula", Values: []string{"mifflin", "katch"}, MaxSelect: 1},
			&core.SelectField{Name: "goal", Values: []string{"lose", "maintain", "gain"}, MaxSelect: 1},
			// manual override; 0 = use the computed TDEE-based budget
			&core.NumberField{Name: "calorie_target"},
			&core.NumberField{Name: "protein_pct"},
			&core.NumberField{Name: "carbs_pct"},
			&core.NumberField{Name: "fat_pct"},
			&core.TextField{Name: "theme_accent"},
			// kg per week; may be negative (loss) or positive (gain)
			&core.NumberField{Name: "goal_rate"},
		)
		// one profile per user
		profiles.AddIndex("idx_profiles_user_unique", true, "user", "")

		if err := app.Save(profiles); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// meal_slots
		// ---------------------------------------------------------------
		mealSlots := core.NewBaseCollection("meal_slots")
		mealSlots.ListRule = types.Pointer(ownerRule)
		mealSlots.ViewRule = types.Pointer(ownerRule)
		mealSlots.CreateRule = types.Pointer(ownerRule)
		mealSlots.UpdateRule = types.Pointer(ownerRule)
		mealSlots.DeleteRule = types.Pointer(ownerRule)

		mealSlots.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "name", Required: true},
			// NB: not Required — PocketBase treats required numbers as
			// "non-zero", but sort_order 0 (first slot) is a valid value.
			&core.NumberField{Name: "sort_order"},
			&core.NumberField{Name: "pct_allocation", Min: types.Pointer(0.0), Max: types.Pointer(100.0)},
		)

		if err := app.Save(mealSlots); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// foods (user nullable — OFF cache rows created server-side have
		// no owner; API rules are still fully user-scoped per spec)
		// ---------------------------------------------------------------
		foods := core.NewBaseCollection("foods")
		foods.ListRule = types.Pointer(ownerRule)
		foods.ViewRule = types.Pointer(ownerRule)
		foods.CreateRule = types.Pointer(ownerRule)
		foods.UpdateRule = types.Pointer(ownerRule)
		foods.DeleteRule = types.Pointer(ownerRule)

		foods.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1},
			&core.TextField{Name: "name", Required: true},
			&core.TextField{Name: "brand"},
			&core.TextField{Name: "barcode"},
			&core.NumberField{Name: "kcal_per_100g", Required: true},
			&core.NumberField{Name: "protein_per_100g"},
			&core.NumberField{Name: "carbs_per_100g"},
			&core.NumberField{Name: "fat_per_100g"},
			&core.NumberField{Name: "default_serving_g"},
			&core.SelectField{Name: "source", Values: []string{"custom", "off", "loseit"}, MaxSelect: 1},
			&core.TextField{Name: "source_id"},
		)
		foods.AddIndex("idx_foods_barcode", false, "barcode", "")
		// upsert key for OFF cache entries: (source, source_id)
		foods.AddIndex("idx_foods_source_sourceId", true, "source, source_id",
			"source = 'off' AND source_id != ''")
		if err := app.Save(foods); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// diary_entries
		// ---------------------------------------------------------------
		diary := core.NewBaseCollection("diary_entries")
		diary.ListRule = types.Pointer(ownerRule)
		diary.ViewRule = types.Pointer(ownerRule)
		diary.CreateRule = types.Pointer(ownerRule)
		diary.UpdateRule = types.Pointer(ownerRule)
		diary.DeleteRule = types.Pointer(ownerRule)

		diary.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.RelationField{Name: "meal_slot", CollectionId: mealSlots.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.RelationField{Name: "food", CollectionId: foods.Id, MaxSelect: 1},
			&core.TextField{Name: "name_snapshot", Required: true},
			&core.TextField{Name: "brand_snapshot"},
			&core.NumberField{Name: "grams"},
			&core.NumberField{Name: "kcal", Required: true},
			&core.NumberField{Name: "protein"},
			&core.NumberField{Name: "carbs"},
			&core.NumberField{Name: "fat"},
			&core.DateField{Name: "logged_at", Required: true},
			&core.SelectField{Name: "source", Values: []string{"manual", "scan", "recipe", "import"}, MaxSelect: 1},
			&core.TextField{Name: "external_id"},
		)
		diary.AddIndex("idx_diary_user_loggedAt", false, "user, logged_at", "")

		if err := app.Save(diary); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// weights
		// ---------------------------------------------------------------
		weights := core.NewBaseCollection("weights")
		weights.ListRule = types.Pointer(ownerRule)
		weights.ViewRule = types.Pointer(ownerRule)
		weights.CreateRule = types.Pointer(ownerRule)
		weights.UpdateRule = types.Pointer(ownerRule)
		weights.DeleteRule = types.Pointer(ownerRule)

		weights.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.NumberField{Name: "kg", Required: true},
			&core.DateField{Name: "measured_at", Required: true},
			&core.TextField{Name: "source"},
		)
		weights.AddIndex("idx_weights_user_measuredAt", false, "user, measured_at", "")

		return app.Save(weights)
	}, func(app core.App) error {
		// down migration: drop in reverse dependency order
		for _, name := range []string{"weights", "diary_entries", "foods", "meal_slots", "profiles"} {
			col, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				continue
			}
			if err := app.Delete(col); err != nil {
				return err
			}
		}
		return nil
	}, "saolrian_init.go")
}

const (
	// standard user-scoped rule: only the owning user may touch the row.
	ownerRule = "user = @request.auth.id"
)
