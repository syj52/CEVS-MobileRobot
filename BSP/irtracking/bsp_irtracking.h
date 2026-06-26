/*
 * bsp_irtracking.h
 *
 *  Created on: Oct 11, 2023
 *      Author: YB-101
 */

#ifndef BSP_IRTRACKING_H_
#define BSP_IRTRACKING_H_

#include "main.h"


#define IN_X1 HAL_GPIO_ReadPin(X1_GPIO_Port,X1_Pin)//读取X1引脚的状态 Read the status of X1 pin
#define IN_X2 HAL_GPIO_ReadPin(X2_GPIO_Port,X2_Pin)//读取X2引脚的状态 Read the status of X2 pin
#define IN_X3 HAL_GPIO_ReadPin(X3_GPIO_Port,X3_Pin)//读取X3引脚的状态 Read the status of X3 pin
#define IN_X4 HAL_GPIO_ReadPin(X4_GPIO_Port,X4_Pin)//读取X4引脚的状态 Read the status of X4 pin

#endif /* BSP_IRTRACKING_H_ */
