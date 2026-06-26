/*
 * camera_driver.c — No esp_cam_ctlr_receive. Uses VB/FIN callbacks + semaphore.
 * CSI passes RAW10 through, ISP does RAW10→RGB565. Proven in camera_test.
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_cache.h"
#include "esp_ldo_regulator.h"
#include "driver/i2c_master.h"
#include "driver/isp.h"
#include "esp_cam_ctlr_csi.h"
#include "esp_cam_ctlr.h"
#include "esp_cam_sensor.h"
#include "example_sensor_init.h"
#include "camera_driver.h"

static const char *TAG="CAM";
#define CAM_W 640
#define CAM_H 480
#define CAM_SZ (CAM_W*CAM_H*2)

static esp_cam_ctlr_handle_t s_cam=NULL;
static isp_proc_handle_t     s_isp=NULL;
static esp_ldo_channel_handle_t s_ldo=NULL;
static i2c_master_bus_handle_t  s_i2c=NULL;
static uint8_t              *s_fb=NULL;
static esp_cam_ctlr_trans_t  s_tr={0};
static SemaphoreHandle_t     s_frame_sem=NULL;

static bool cb_vb(esp_cam_ctlr_handle_t h,esp_cam_ctlr_trans_t*t,void*u){
    esp_cam_ctlr_trans_t*ut=(esp_cam_ctlr_trans_t*)u;
    t->buffer=ut->buffer;t->buflen=ut->buflen;return false;
}
static bool cb_fin(esp_cam_ctlr_handle_t h,esp_cam_ctlr_trans_t*t,void*u){
    (void)h;(void)t;(void)u;
    BaseType_t w=pdFALSE;xSemaphoreGiveFromISR(s_frame_sem,&w);return w==pdTRUE;
}

esp_err_t camera_init(void){
    s_frame_sem=xSemaphoreCreateBinary();
    esp_ldo_channel_config_t lc={.chan_id=3,.voltage_mv=2500};
    ESP_ERROR_CHECK(esp_ldo_acquire_channel(&lc,&s_ldo));
    example_sensor_config_t sc={.i2c_port_num=I2C_NUM_0,.i2c_sda_io_num=GPIO_NUM_7,.i2c_scl_io_num=GPIO_NUM_8,.port=ESP_CAM_SENSOR_MIPI_CSI,.format_name="MIPI_2lane_24Minput_RAW10_640x480_50fps"};
    example_sensor_handle_t sh={0};example_sensor_init(&sc,&sh);s_i2c=sh.i2c_bus_handle;
    s_fb=heap_caps_aligned_alloc(64,CAM_SZ,MALLOC_CAP_SPIRAM|MALLOC_CAP_DMA);
    if(!s_fb)s_fb=heap_caps_aligned_alloc(64,CAM_SZ,MALLOC_CAP_INTERNAL|MALLOC_CAP_DMA);
    if(!s_fb)return ESP_ERR_NO_MEM;
    s_tr.buffer=s_fb;s_tr.buflen=CAM_SZ;
    /* CSI: internal backup buffers hold ISP output */
    esp_cam_ctlr_csi_config_t cc={.ctlr_id=0,.h_res=CAM_W,.v_res=CAM_H,.data_lane_num=2,.lane_bit_rate_mbps=200,.input_data_color_type=CAM_CTLR_COLOR_RAW10,.output_data_color_type=CAM_CTLR_COLOR_RGB565,.queue_items=2,.byte_swap_en=false,.bk_buffer_dis=true};
    ESP_ERROR_CHECK(esp_cam_new_csi_ctlr(&cc,&s_cam));
    esp_cam_ctlr_evt_cbs_t cb={.on_get_new_trans=cb_vb,.on_trans_finished=cb_fin};
    ESP_ERROR_CHECK(esp_cam_ctlr_register_event_callbacks(s_cam,&cb,&s_tr));
    ESP_ERROR_CHECK(esp_cam_ctlr_enable(s_cam));
    /* ISP: RAW10→RGB565, BGGR Bayer */
    esp_isp_processor_cfg_t ic={.clk_hz=80*1000*1000,.input_data_source=ISP_INPUT_DATA_SOURCE_CSI,.input_data_color_type=ISP_COLOR_RAW10,.output_data_color_type=ISP_COLOR_RGB565,.has_line_start_packet=false,.has_line_end_packet=false,.h_res=CAM_W,.v_res=CAM_H,.bayer_order=COLOR_RAW_ELEMENT_ORDER_BGGR};
    ESP_ERROR_CHECK(esp_isp_new_processor(&ic,&s_isp));
    ESP_ERROR_CHECK(esp_isp_enable(s_isp));
    /* Start sensor + CSI */
    vTaskDelay(pdMS_TO_TICKS(200));
    {i2c_master_dev_handle_t d;i2c_device_config_t dc={.dev_addr_length=I2C_ADDR_BIT_LEN_7,.device_address=0x30,.scl_speed_hz=400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(s_i2c,&dc,&d));
    uint8_t w[]={0x01,0x00,0x01};ESP_ERROR_CHECK(i2c_master_transmit(d,w,3,100));
    ESP_ERROR_CHECK(i2c_master_bus_rm_device(d));}
    ESP_ERROR_CHECK(esp_cam_ctlr_start(s_cam));
    ESP_LOGI(TAG,"ready (no-queue mode)");
    return ESP_OK;
}

esp_err_t camera_grab_frame(uint8_t **buf, size_t *len){
    if(xSemaphoreTake(s_frame_sem,pdMS_TO_TICKS(2000))!=pdTRUE){*buf=NULL;*len=0;return ESP_ERR_TIMEOUT;}
#if CONFIG_SPIRAM
    esp_cache_msync(s_fb,CAM_SZ,ESP_CACHE_MSYNC_FLAG_DIR_M2C);
#endif
    *buf=s_fb;*len=CAM_SZ;return ESP_OK;
}
void camera_get_resolution(uint16_t*w,uint16_t*h){if(w)*w=CAM_W;if(h)*h=CAM_H;}
esp_err_t camera_deinit(void){return ESP_OK;}
