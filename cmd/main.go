package main

import (
	"fmt"
	"os"

	"github.com/ignorantshr/go-call-graph/internal/analyzer"
	"github.com/ignorantshr/go-call-graph/internal/config"
	"github.com/ignorantshr/go-call-graph/internal/server"
	"github.com/spf13/cobra"
)

func main() {
	var (
		dir        string
		port       int
		dev        bool
		configFile string
	)

	rootCmd := &cobra.Command{
		Use:   "go-call-graph",
		Short: "Interactive Go source code call graph analyzer",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Load config: defaults → file → CLI flags
			var cfg *config.Config
			if configFile != "" {
				var err error
				cfg, err = config.Load(configFile)
				if err != nil {
					return fmt.Errorf("loading config: %w", err)
				}
			} else {
				cfg = config.DefaultConfig()
			}

			// CLI flags override config file values
			if cmd.Flags().Changed("dir") {
				cfg.Dir = dir
			}
			if cmd.Flags().Changed("port") {
				cfg.Port = port
			}
			if cmd.Flags().Changed("dev") {
				cfg.Dev = dev
			}

			fmt.Printf("Analyzing project at: %s\n", cfg.Dir)
			result, err := analyzer.Analyze(cfg)
			if err != nil {
				return fmt.Errorf("analysis failed: %w", err)
			}

			fmt.Printf("Analysis complete:\n")
			fmt.Printf("  Packages:  %d\n", len(result.Packages))
			fmt.Printf("  Files:     %d\n", len(result.Files))
			fmt.Printf("  Functions: %d\n", len(result.Functions))
			if result.CallGraph != nil {
				fmt.Printf("  Call graph nodes: %d\n", len(result.CallGraph.Nodes))
			}

			srv := server.New(result, cfg)
			return srv.Start()
		},
	}

	rootCmd.Flags().StringVarP(&configFile, "config", "c", "", "Path to YAML config file")
	rootCmd.Flags().StringVarP(&dir, "dir", "d", ".", "Target Go project directory")
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().BoolVar(&dev, "dev", false, "Serve frontend from filesystem (for development)")

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
