package api

import (
	"testing"

	"github.com/Raminga/raminga/internal/node"
)

func TestSendOriginMappingNeverDowngradesAgent(t *testing.T) {
	cases := []struct {
		value string
		agent bool
		want  string
		bad   bool
	}{
		{"", false, node.OriginUnknown, false},
		{"human", false, node.OriginHuman, false},
		{" HUmAn ", false, node.OriginHuman, false},
		{"agent", false, node.OriginAgent, false},
		{"unknown", false, node.OriginUnknown, false},
		{"human", true, node.OriginAgent, false},
		{"", true, node.OriginAgent, false},
		{"root", false, "", true},
	}
	for _, tc := range cases {
		got, err := sendOrigin(tc.value, tc.agent)
		if tc.bad {
			if err == nil {
				t.Fatalf("sendOrigin(%q,%t) unexpectedly succeeded with %q", tc.value, tc.agent, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Fatalf("sendOrigin(%q,%t) = %q, %v; want %q", tc.value, tc.agent, got, err, tc.want)
		}
	}
}
