{
  description = "PayPal AI Hackathon 2026 MVP, built on the platform flake";

  inputs.platform.url = "git+ssh://git@github.com/jeirslab/paypal-hackathon-2026";

  outputs = { self, platform }: {
    devShells = platform.devShells;
  };
}
