{
  "targets": [
    {
      "target_name": "iracing_native",
      "sources": [
        "src/addon.cc",
        "assets/irsdk_1_19/irsdk_utils.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "assets/irsdk_1_19"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["user32.lib", "kernel32.lib", "winmm.lib"]
        }]
      ]
    }
  ]
}
