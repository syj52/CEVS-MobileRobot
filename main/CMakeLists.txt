idf_component_register(
    SRCS "main.c"
         "camera_driver.c"
         "streamer.c"
         "network/wifi_manager.c"
         "network/tcp_client.c"
         "nav/nav_grid.c"
    INCLUDE_DIRS "." "network" "nav"
    REQUIRES esp_driver_cam
             esp_driver_isp
             esp_cam_sensor
             esp_sccb_intf
             sensor_init
             esp_http_server
             nvs_flash
             esp_wifi
             esp_netif
             esp_event
             esp_timer
             driver
)
