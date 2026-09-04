package source

import "testing"

func TestCheckedInMappingsLoad(t *testing.T) {
	for _, name := range []string{"usda"} {
		t.Run(name, func(t *testing.T) {
			m, err := LoadNamedMapping(name)
			if err != nil {
				t.Fatalf("LoadNamedMapping(%q): %v", name, err)
			}
			if len(m.Codes()) < 20 {
				t.Errorf("%s mapping has only %d codes; expected a full profile", name, len(m.Codes()))
			}
			if _, _, ok := m.Apply("208", 100); !ok {
				t.Error("usda mapping is missing energy (208)")
			}
		})
	}
}

func TestUSDAMapsEnergyToKcal(t *testing.T) {
	m, err := LoadNamedMapping("usda")
	if err != nil {
		t.Fatalf("LoadNamedMapping: %v", err)
	}
	key, v, ok := m.Apply("208", 89)
	if !ok || key != "energy_kcal" || v != 89 {
		t.Errorf("Apply(208, 89) = %q, %v, %v", key, v, ok)
	}
}
