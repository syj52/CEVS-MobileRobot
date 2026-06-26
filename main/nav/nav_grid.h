#ifndef NAV_GRID_H
#define NAV_GRID_H

#include <stdbool.h>
#include <stdint.h>

/* ─── 地图结构 ─────────────────────────────────────────────── */
#define MAP_MAX_W  512
#define MAP_MAX_H  512

typedef struct {
    int      width;
    int      height;
    float    res;    /* 米/格 */
    float    ox, oy; /* 左下角世界坐标 */
    uint8_t  data[MAP_MAX_W * MAP_MAX_H];
    bool     valid;
} grid_map_t;

extern grid_map_t g_grid_map;

/* ─── 初始化 ───────────────────────────────────────────────── */
/**
 * @brief 用 Center 传来的参数初始化/重置地图缓冲区。
 *        调用后地图 valid=false，等待收到 MAP:END 后由调用方置 valid=true。
 *
 * @param w       栅格列数
 * @param h       栅格行数
 * @param res     分辨率（米/格）
 * @param origin_x 世界坐标原点 X（左下角）
 * @param origin_y 世界坐标原点 Y（左下角）
 */
void grid_map_init(int w, int h, float res, float origin_x, float origin_y);

/* ─── 查询 ─────────────────────────────────────────────────── */
/**
 * @brief 查询世界坐标 (wx, wy) 对应栅格是否可通行。
 *        free (254) → true，occupied (0) → false。
 *
 * @param wx 世界坐标 X（米）
 * @param wy 世界坐标 Y（米）
 * @return true 可通行，false 障碍/无效/越界
 */
bool grid_is_passable(float wx, float wy);

#endif /* NAV_GRID_H */
