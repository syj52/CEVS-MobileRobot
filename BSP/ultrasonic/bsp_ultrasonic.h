
#ifndef __BSP_ULTRASONIC_H__
#define __BSP_ULTRASONIC_H__

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "bsp.h"


float Get_distance(void);

/* 超声波诊断: 非零表示最近一次测距的超时阶段
 *   0 = 测距成功
 *   1 = ECHO 上升沿超时 (模块没响应/没接)
 *   2 = ECHO 下降沿超时 (回波异常长)
 */
extern volatile uint8_t g_us_timeout_reason;

#ifdef __cplusplus
}
#endif
#endif /*__BSP_ULTRASONIC_H__*/

