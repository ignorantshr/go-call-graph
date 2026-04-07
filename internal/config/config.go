package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

// CallgraphConfig holds call graph related settings.
type CallgraphConfig struct {
	DefaultDepth int `yaml:"default_depth"`
}

// MuteRule defines a single mute rule.
type MuteRule struct {
	Type    string `yaml:"type" json:"type"`       // "stdlib", "external", "package", "func", "pattern"
	Pattern string `yaml:"pattern" json:"pattern"` // required for package/func/pattern types
}

// Config is the top-level configuration.
type Config struct {
	Dir       string          `yaml:"dir"`
	Port      int             `yaml:"port"`
	Dev       bool            `yaml:"dev"`
	Exclude   []string        `yaml:"exclude"` // relative dirs to exclude from analysis
	Callgraph CallgraphConfig `yaml:"callgraph"`
	Mute      []MuteRule      `yaml:"mute"`
}

// DefaultConfig returns a Config with all default values.
func DefaultConfig() *Config {
	return &Config{
		Dir:  ".",
		Port: 8080,
		Callgraph: CallgraphConfig{
			DefaultDepth: 2,
		},
		Mute: []MuteRule{
			{Type: "stdlib"},
		},
	}
}

// Load reads a YAML config file and returns a Config.
// Fields not present in the file retain their default values.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg := DefaultConfig()
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}
