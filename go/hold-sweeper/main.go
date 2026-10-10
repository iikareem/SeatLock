package main

import "fmt"

// Hold sweeper — releases expired holds that were never converted to PAYING/SOLD.
// TODO: scheduled Lambda; check expiresAt; never trust DynamoDB TTL alone.

func main() {
	fmt.Println("TODO: hold-sweeper")
}
