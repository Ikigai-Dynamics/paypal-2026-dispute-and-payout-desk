# Options only: the platform owns every builder, image, manifest and script.
{ platformLib, pkgs, ... }:
let
  desk = platformLib.buildNodeService {
    pname = "desk";
    src = ../desk;
    linkPackages = platformLib.sharedNodePackages;
    testLinkPackages = platformLib.sharedTestNodePackages;
    testScript = "test";
  };
  decide = platformLib.buildRustService {
    pname = "decide";
    src = ../decide;
    # the golden cases are include_str!'d by the unit tests
    extraSrcSuffixes = [ ".json" ];
  };
  e2e = pkgs.writeShellApplication {
    name = "e2e";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = builtins.readFile ../scripts/lib.sh + builtins.readFile ../scripts/e2e.sh;
  };
  demoReset = pkgs.writeShellApplication {
    name = "demo-reset";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = builtins.readFile ../scripts/lib.sh + builtins.readFile ../scripts/demo-reset.sh;
  };
  # contracts/ is the canonical fixture; the crate and the desk each carry a copy
  # because their sources are built from their own directories.
  fixtureCopiesMatch =
    pkgs.runCommand "decide-fixtures-identical"
      {
        canonical = ../contracts/fixtures/decide.v2.cases.json;
        rust = ../decide/fixtures/decide.v2.cases.json;
        ts = ../desk/test/fixtures/decide.v2.cases.json;
      }
      ''
        cmp $canonical $rust
        cmp $canonical $ts
        touch $out
      '';
in
{
  platform = {
    project = {
      name = "dispute-and-payout-desk";
      readme = ../README.md;
    };
    services.desk = {
      package = desk;
      # shortcut: drafts and decisions are cached in memory per pod; move them to Postgres before scaling out
      replicas = 1;
      # LLM_BASE_URL, LLM_MODEL and LLM_API_KEY come from platform.llm
      env.DECIDE_URL = "http://decide";
      # shortcut: every desk pod start reseeds the demo; drop before any real merchant data
      env.DEMO_RESET_ON_BOOT = "1";
      ingress.enable = true;
    };
    services.decide = {
      package = decide;
      replicas = 2;
    };
    # replicas stays 1: the mock keeps its state in memory
    paypalMock = {
      enable = true;
    };
    postgres.enable = true;
    otel.enable = true;
    extraPackages.e2e = e2e;
    extraPackages.demo-reset = demoReset;
    extraChecks = decide.passthru.checks // desk.passthru.checks // { inherit fixtureCopiesMatch; };
  };
}
