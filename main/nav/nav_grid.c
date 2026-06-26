#include "nav_grid.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "nav_grid";

grid_map_t g_grid_map = {
    .width  = 0,
    .height = 0,
    .res    = 0.0f,
    .ox     = 0.0f,
    .oy     = 0.0f,
    .valid  = false,
    /* data 零初始化 */
};

void grid_map_init(int w, int h, float res, float origin_x, float origin_y)
{
    if (w <= 0 || w > MAP_MAX_W || h <= 0 || h > MAP_MAX_H) {
        ESP_LOGE(TAG, "grid_map_init: invalid size %dx%d (max %dx%d)",
                 w, h, MAP_MAX_W, MAP_MAX_H);
        return;
    }

    g_grid_map.width  = w;
    g_grid_map.height = h;
    g_grid_map.res    = res;
    g_grid_map.ox     = origin_x;
    g_grid_map.oy     = origin_y;
    g_grid_map.valid  = false;  /* 等待 MAP:END 后由调用方置 true */

    ESP_LOGI(TAG, "grid_map reset: %dx%d  res=%.3f  origin=(%.2f, %.2f)",
             w, h, res, origin_x, origin_y);
}

bool grid_is_passable(float wx, float wy)
{
    if (!g_grid_map.valid) {
        return false;  /* 地图未加载，保守拒绝 */
    }

    /* 世界坐标 → 栅格索引 */
    int col = (int)((wx - g_grid_map.ox) / g_grid_map.res);
    int row = (int)((wy - g_grid_map.oy) / g_grid_map.res);

    /* 越界检查 */
    if (col < 0 || col >= g_grid_map.width ||
        row < 0 || row >= g_grid_map.height) {
        return false;
    }

    return g_grid_map.data[row * g_grid_map.width + col] == 254;
}
