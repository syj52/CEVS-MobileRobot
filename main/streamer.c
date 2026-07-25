/* streamer — HTTP server for audio streaming only (camera via RTSP). */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "streamer.h"
#include "audio_mic.h"

static const char *TAG="STREAM";
static httpd_handle_t s_httpd=NULL;

static esp_err_t wav_h(httpd_req_t *r){
    if (!audio_mic_is_ready()) {
        httpd_resp_set_status(r, "503");
        httpd_resp_sendstr(r, "audio not ready");
        return ESP_FAIL;
    }
    size_t pcm_len;
    const int16_t *pcm = audio_mic_get_latest_block(&pcm_len);
    if (!pcm || pcm_len == 0) {
        httpd_resp_set_status(r, "503");
        httpd_resp_sendstr(r, "no audio data");
        return ESP_FAIL;
    }
    uint32_t sr = 16000; uint16_t ch = 1, bps = 16;
    uint16_t ba = ch * (bps / 8);
    uint32_t brate = sr * ba, data_sz = (uint32_t)pcm_len, riff_sz = 36 + data_sz;
    uint8_t wav[44];
    memcpy(wav, "RIFF", 4);
    wav[4]=riff_sz&0xFF; wav[5]=(riff_sz>>8)&0xFF; wav[6]=(riff_sz>>16)&0xFF; wav[7]=(riff_sz>>24)&0xFF;
    memcpy(wav+8, "WAVE", 4); memcpy(wav+12, "fmt ", 4);
    wav[16]=16; wav[17]=0; wav[18]=0; wav[19]=0;
    wav[20]=1; wav[21]=0; wav[22]=ch&0xFF; wav[23]=(ch>>8)&0xFF;
    wav[24]=sr&0xFF; wav[25]=(sr>>8)&0xFF; wav[26]=(sr>>16)&0xFF; wav[27]=(sr>>24)&0xFF;
    wav[28]=brate&0xFF; wav[29]=(brate>>8)&0xFF; wav[30]=(brate>>16)&0xFF; wav[31]=(brate>>24)&0xFF;
    wav[32]=ba; wav[33]=0; wav[34]=bps; wav[35]=0;
    memcpy(wav+36, "data", 4);
    wav[40]=data_sz&0xFF; wav[41]=(data_sz>>8)&0xFF; wav[42]=(data_sz>>16)&0xFF; wav[43]=(data_sz>>24)&0xFF;
    size_t total_sz = 44 + pcm_len;
    uint8_t *resp = heap_caps_malloc(total_sz, MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!resp)resp=malloc(total_sz);
    if(!resp){httpd_resp_set_status(r,"503");httpd_resp_sendstr(r,"oom");return ESP_FAIL;}
    memcpy(resp, wav, 44); memcpy(resp+44, pcm, pcm_len);
    httpd_resp_set_type(r,"audio/wav");
    esp_err_t hr = httpd_resp_send(r,(const char*)resp,(int)total_sz);
    free(resp); return hr;
}

static esp_err_t audio_html_h(httpd_req_t*r){
    const char*page=
"<!DOCTYPE html><html><head><meta charset='utf-8'><title>Mic Live</title>"
"<style>body{background:#111;color:#eee;font:16px sans;text-align:center;padding:40px}"
"#v{font-size:48px;cursor:pointer;user-select:none}.s{color:#888;font-size:13px}"
"</style></head><body>"
"<div id='v' onclick='toggle()'>🎤</div><div id='s' class='s'>Click mic</div>"
"<script>"
"let ctx=null,nextTime=0,active=false;"
"async function poll(){if(!active)return;"
"try{let r=await fetch('/mic.wav');if(!r.ok)return;"
"let b=await r.arrayBuffer(),dv=new DataView(b);"
"let nS=(b.byteLength-44)/2;if(nS<1)return;"
"let f32=new Float32Array(nS);"
"for(let i=0;i<nS;i++)f32[i]=dv.getInt16(44+i*2,true)/32768;"
"let buf=ctx.createBuffer(1,nS,16000);buf.copyToChannel(f32,0);"
"let src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);"
"let now=ctx.currentTime;if(nextTime<now)nextTime=now;"
"src.start(nextTime);nextTime+=buf.duration;"
"document.getElementById('s').textContent='Live'"
"}catch(e){document.getElementById('s').textContent=e.message}"
"setTimeout(poll,120)}"
"function toggle(){if(!active){ctx=new AudioContext();nextTime=ctx.currentTime;active=true;poll();"
"document.getElementById('v').textContent='🔴'}else{active=false;ctx.close();ctx=null;"
"document.getElementById('v').textContent='🎤';document.getElementById('s').textContent='Stopped'}}"
"</script></body></html>";
    httpd_resp_set_type(r,"text/html");httpd_resp_send(r,page,strlen(page));return ESP_OK;
}

static esp_err_t status_h(httpd_req_t*r){
    httpd_resp_set_type(r,"application/json");
    httpd_resp_sendstr(r,"{\"ok\":1}");return ESP_OK;
}

esp_err_t start_streaming_server(void){
    httpd_config_t c=HTTPD_DEFAULT_CONFIG();c.stack_size=4096;c.max_uri_handlers=6;
    ESP_ERROR_CHECK(httpd_start(&s_httpd,&c));
    httpd_uri_t us[]={
        {.uri="/mic.wav",.method=HTTP_GET,.handler=wav_h},
        {.uri="/audio",.method=HTTP_GET,.handler=audio_html_h},
        {.uri="/status",.method=HTTP_GET,.handler=status_h}};
    for(int i=0;i<3;i++)httpd_register_uri_handler(s_httpd,&us[i]);
    ESP_LOGI(TAG,"ready (audio only; camera via RTSP)");
    return ESP_OK;
}
esp_err_t stop_streaming_server(void){if(s_httpd)httpd_stop(s_httpd);return ESP_OK;}
