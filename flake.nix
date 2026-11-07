{
  description = "PayPal AI Hackathon 2026: dispute and payout desk, built on the platform flake";

  inputs.platform.url = "git+ssh://git@github.com/Ikigai-Dynamics/paypal-hackathon-2026";

  outputs = inputs: inputs.platform.lib.mkFlake { inherit inputs; } { project = ./nix/project.nix; };
}
