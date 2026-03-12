package main

import (
	"fmt"
	"os"

	"github.com/haoran-shi/go-call-graph/internal/analyzer"
	"github.com/haoran-shi/go-call-graph/internal/server"
	"github.com/spf13/cobra"
)

func main() {
	var (
		dir  string
		port int
		dev  bool
	)

	rootCmd := &cobra.Command{
		Use:   "go-call-graph",
		Short: "Interactive Go source code call graph analyzer",
		RunE: func(cmd *cobra.Command, args []string) error {
			if dir == "" {
				dir = "."
			}

			fmt.Printf("Analyzing project at: %s\n", dir)
			result, err := analyzer.Analyze(dir)
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

			srv := server.New(result, port, dev)
			return srv.Start()
		},
	}

	rootCmd.Flags().StringVarP(&dir, "dir", "d", ".", "Target Go project directory")
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().BoolVar(&dev, "dev", false, "Serve frontend from filesystem (for development)")

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
