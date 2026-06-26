/* streamer — sema frame grab + HTTP cache, 640x480, fixed RGB565 decode */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "streamer.h"
#include "camera_driver.h"
#include "network/wifi_manager.h"

static const char *TAG="STREAM";
static httpd_handle_t s_httpd=NULL;
static SemaphoreHandle_t s_mux=NULL;
#define CACHE_SZ (640*480*2)
static uint8_t *s_cache=NULL;
static size_t s_cache_len=0;

static void frame_grabber(void *arg){
    (void)arg;
    while(1){
        uint8_t *fb;size_t len;
        if(camera_grab_frame(&fb,&len)==ESP_OK&&fb&&len){
            xSemaphoreTake(s_mux,portMAX_DELAY);
            if(len<=CACHE_SZ){memcpy(s_cache,fb,len);s_cache_len=len;}
            xSemaphoreGive(s_mux);
        }
    }
}

static esp_err_t raw_h(httpd_req_t *r){
    xSemaphoreTake(s_mux,pdMS_TO_TICKS(100));
    if(!s_cache_len){xSemaphoreGive(s_mux);httpd_resp_set_status(r,"503");httpd_resp_sendstr(r,"wait");return ESP_FAIL;}
    uint8_t *copy=malloc(s_cache_len);
    if(copy)memcpy(copy,s_cache,s_cache_len);
    size_t l=s_cache_len;
    xSemaphoreGive(s_mux);
    if(!copy){httpd_resp_set_status(r,"503");httpd_resp_sendstr(r,"oom");return ESP_FAIL;}
    httpd_resp_set_type(r,"application/octet-stream");
    httpd_resp_send(r,(const char*)copy,(int)l);
    free(copy);
    return ESP_OK;
}
static esp_err_t status_h(httpd_req_t*r){httpd_resp_set_type(r,"application/json");httpd_resp_sendstr(r,"{\"ok\":1}");return ESP_OK;}
static esp_err_t idx_h(httpd_req_t*r){
    const char*h=
"<!DOCTYPE html><html><head><meta charset='utf-8'><title>Cam</title>"
"<style>body{background:#111;color:#eee;text-align:center;font:sans}canvas{border:2px solid #444;max-width:100%}</style></head><body>"
"<h2>SC2336 640x480</h2><canvas id='c'></canvas>"
"<p><button onclick='go()'>Stream</button> <span id='s'></span></p>"
"<script>"
"let w=640,h=480,r=false;function go(){r=!r}"
"async function t(){if(!r){setTimeout(t,300);return}"
"try{let res=await fetch('/raw');if(!res.ok)return;"
"let d=await res.arrayBuffer(),v=new Uint8Array(d);"
"let c=document.getElementById('c');c.width=w;c.height=h;"
"let x=c.getContext('2d'),img=x.createImageData(w,h);"
"for(let i=0;i<w*h;i++){let lo=v[i*2],hi=v[i*2+1];"
"img.data[i*4]=((hi>>3)&31)<<3;"
"img.data[i*4+1]=(((hi&7)<<3)|(lo>>5))<<2;"
"img.data[i*4+2]=(lo&31)<<3;img.data[i*4+3]=255}"
"x.putImageData(img,0,0);document.getElementById('s').textContent=new Date().toLocaleTimeString()}"
"catch(e){document.getElementById('s').textContent=e.message}"
"setTimeout(t,300)}t()</script></body></html>";
    httpd_resp_set_type(r,"text/html");httpd_resp_send(r,h,strlen(h));return ESP_OK;
}
esp_err_t start_streaming_server(void){
    s_mux=xSemaphoreCreateMutex();
    s_cache=heap_caps_malloc(CACHE_SZ,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!s_cache)s_cache=malloc(CACHE_SZ);
    if(!s_cache)return ESP_ERR_NO_MEM;
    xTaskCreate(frame_grabber,"fb",4096,NULL,tskIDLE_PRIORITY+2,NULL);
    int w=0;while(!wifi_manager_is_connected()&&w<100){vTaskDelay(pdMS_TO_TICKS(100));w++;}
    httpd_config_t c=HTTPD_DEFAULT_CONFIG();c.stack_size=4096;c.max_uri_handlers=8;
    ESP_ERROR_CHECK(httpd_start(&s_httpd,&c));
    httpd_uri_t us[]={{.uri="/",.method=HTTP_GET,.handler=idx_h},{.uri="/raw",.method=HTTP_GET,.handler=raw_h},{.uri="/status",.method=HTTP_GET,.handler=status_h}};
    for(int i=0;i<3;i++)httpd_register_uri_handler(s_httpd,&us[i]);
    ESP_LOGI(TAG,"ready");
    return ESP_OK;
}
esp_err_t stop_streaming_server(void){if(s_httpd)httpd_stop(s_httpd);return ESP_OK;}
