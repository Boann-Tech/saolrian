// Package migrations registers the Saolrian app collections with PocketBase.
//
// Adds the collections and fields needed to import a full LoseIt export:
// exercise logs (no prior home), a background job record so imports can
// run async and be observed via realtime, push subscriptions for
// completion notifications, and two additive fields on daily_metrics plus
// a second dedup index on foods for LoseIt-sourced rows.
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
		// exercise_entries
		// ---------------------------------------------------------------
		exercise := core.NewBaseCollection("exercise_entries")
		exercise.ListRule = types.Pointer(ownerRule)
		exercise.ViewRule = types.Pointer(ownerRule)
		exercise.CreateRule = types.Pointer(ownerRule)
		exercise.UpdateRule = types.Pointer(ownerRule)
		exercise.DeleteRule = types.Pointer(ownerRule)

		exercise.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "name", Required: true},
			&core.NumberField{Name: "minutes", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "kcal", Required: true},
			&core.DateField{Name: "logged_at", Required: true},
			&core.SelectField{Name: "source", Values: []string{"manual", "import"}, MaxSelect: 1},
			&core.TextField{Name: "external_id"},
		)
		exercise.AddIndex("idx_exercise_user_loggedAt", false, "user, logged_at", "")
		exercise.AddIndex("idx_exercise_dedup", true, "user, source, external_id", "external_id != ''")
		if err := app.Save(exercise); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// import_jobs
		// ---------------------------------------------------------------
		jobs := core.NewBaseCollection("import_jobs")
		jobs.ListRule = types.Pointer(ownerRule)
		jobs.ViewRule = types.Pointer(ownerRule)
		jobs.CreateRule = types.Pointer(ownerRule)
		jobs.UpdateRule = types.Pointer(ownerRule)
		jobs.DeleteRule = types.Pointer(ownerRule)

		jobs.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.SelectField{Name: "status", Values: []string{"queued", "running", "done", "failed"}, Required: true, MaxSelect: 1},
			&core.JSONField{Name: "categories", MaxSize: 4096},
			&core.JSONField{Name: "counts", MaxSize: 4096},
			&core.TextField{Name: "error"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		if err := app.Save(jobs); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// push_subscriptions
		// ---------------------------------------------------------------
		subs := core.NewBaseCollection("push_subscriptions")
		subs.ListRule = types.Pointer(ownerRule)
		subs.ViewRule = types.Pointer(ownerRule)
		subs.CreateRule = types.Pointer(ownerRule)
		subs.UpdateRule = types.Pointer(ownerRule)
		subs.DeleteRule = types.Pointer(ownerRule)

		subs.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "endpoint", Required: true},
			&core.TextField{Name: "p256dh", Required: true},
			&core.TextField{Name: "auth", Required: true},
			&core.AutodateField{Name: "created", OnCreate: true},
		)
		subs.AddIndex("idx_push_subs_user_endpoint", true, "user, endpoint", "")
		if err := app.Save(subs); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// daily_metrics: sleep_hours + body_fat_pct
		// ---------------------------------------------------------------
		metrics, err := app.FindCollectionByNameOrId("daily_metrics")
		if err != nil {
			return err
		}
		metrics.Fields.Add(
			&core.NumberField{Name: "sleep_hours", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "body_fat_pct", Min: types.Pointer(0.0)},
		)
		if err := app.Save(metrics); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// foods: dedup index for LoseIt-sourced rows
		// ---------------------------------------------------------------
		foods, err := app.FindCollectionByNameOrId("foods")
		if err != nil {
			return err
		}
		foods.AddIndex("idx_foods_source_sourceId_loseit", true, "source, source_id",
			"source = 'loseit' AND source_id != ''")
		return app.Save(foods)
	}, func(app core.App) error {
		for _, name := range []string{"push_subscriptions", "import_jobs", "exercise_entries"} {
			col, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				continue
			}
			if err := app.Delete(col); err != nil {
				return err
			}
		}

		if foods, err := app.FindCollectionByNameOrId("foods"); err == nil {
			foods.RemoveIndex("idx_foods_source_sourceId_loseit")
			if err := app.Save(foods); err != nil {
				return err
			}
		}

		if metrics, err := app.FindCollectionByNameOrId("daily_metrics"); err == nil {
			metrics.Fields.RemoveByName("sleep_hours")
			metrics.Fields.RemoveByName("body_fat_pct")
			if err := app.Save(metrics); err != nil {
				return err
			}
		}

		return nil
	}, "saolrian_loseit_import.go")
}
