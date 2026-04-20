{
  "targets": [
    {
      "target_name": "audio_native",
      "sources": [
        "src/addon.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["ole32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "DisableSpecificWarnings": ["4244", "4267", "4996"]
            }
          }
        }]
      ]
    }
  ]
}
