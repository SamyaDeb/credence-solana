# Backtest

`gap-cover-backtest.json`: a model Gap Cover book priced with the program's own pricing code and replayed through the
dated historical closures of the joint stress set. Method, parameters and caveats are inside the file; results are
summarised in the main README under Pricing.

Regenerate with `cargo run -p credence-core --example backtest --release`.
