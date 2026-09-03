// Saolrian backend — PocketBase v0.40.2 used as a Go framework.
//
// The app boots PocketBase, applies the saolrian app migrations (collection
// bootstrap), seeds defaults for new users, registers the custom
// /api/saolrian/ routes and serves the API on 0.0.0.0:8090 (via the serve
// --http flag). The frontend is served separately, so no public static dir
// is wired up.
package main

import (
	"log"
	"os"

	_ "github.com/boanntech/saolrian/backend/internal/migrations" // registers app migrations

	"github.com/boanntech/saolrian/backend/internal/bootstrap"
	"github.com/boanntech/saolrian/backend/internal/routes"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func main() {
	// make `serve` the default command when the binary is invoked bare
	if len(os.Args) < 2 {
		os.Args = append(os.Args, "serve")
	}

	app := pocketbase.New()

	// Bootstrap hook: every new users record gets a profile row and the
	// default meal slots.
	bootstrap.Register(app)

	// Custom routes under /api/saolrian/.
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		routes.Register(se.Router)
		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
