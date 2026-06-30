idf_component_register(
    SRCS "main.c"
         "video_dev.c"
         "rtsp_service.c"
         "streamer.c"
         "audio_mic.c"
         "uart_stm32.c"
         "motion.c"
         "network/wifi_manager.c"
         "network/tcp_client.c"
         "nav/nav_grid.c"
    INCLUDE_DIRS "." "network" "nav"
    REQUIRES esp_http_server
             nvs_flash
             esp_wifi
             esp_netif
             esp_event
             esp_timer
             driver
             esp_driver_i2s
             esp_driver_i2c
             esp_codec_dev
             esp_video
             esp_media_protocols
             mdns
             media_lib_sal
)
