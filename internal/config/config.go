package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

// CallgraphConfig holds call graph related settings.
type CallgraphConfig struct {
	DefaultDepth int `yaml:"default_depth"`
}

// ClassifierConfig holds statement classification settings.
type ClassifierConfig struct {
	LogPackages     []string `yaml:"log_packages"`
	LogFuncPrefixes []string `yaml:"log_func_prefixes"`
}

// Config is the top-level configuration.
type Config struct {
	Dir        string           `yaml:"dir"`
	Port       int              `yaml:"port"`
	Dev        bool             `yaml:"dev"`
	Exclude    []string         `yaml:"exclude"` // relative dirs to exclude from analysis
	Callgraph  CallgraphConfig  `yaml:"callgraph"`
	Classifier ClassifierConfig `yaml:"classifier"`
}

// DefaultConfig returns a Config with all default values.
func DefaultConfig() *Config {
	return &Config{
		Dir:  ".",
		Port: 8080,
		Callgraph: CallgraphConfig{
			DefaultDepth: 2,
		},
		Classifier: ClassifierConfig{
			LogPackages: []string{
				"log",
				"log/slog",
				"go.uber.org/zap",
				"github.com/sirupsen/logrus",
				"github.com/rs/zerolog",
				"github.com/rs/zerolog/log",
			},
			LogFuncPrefixes: []string{
				"Log", "Debug", "Info", "Warn", "Error", "Fatal", "Panic",
				"Printf", "Println", "Print",
				"Debugf", "Infof", "Warnf", "Errorf", "Fatalf", "Panicf",
				"Debugw", "Infow", "Warnw", "Errorw", "Fatalw",
			},
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
