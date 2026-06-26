/*
 * app_ultrasonic.h
 *
 *  Created on: Oct 26, 2023
 *      Author: YB-101
 */

#ifndef ULTRASONIC_APP_ULTRASONIC_H_
#define ULTRASONIC_APP_ULTRASONIC_H_

#include "bsp.h"
void Ultrasonic_avoidance(uint16_t distance);
void Ultrasonic_follow(uint16_t Max_distance,uint16_t Min_distance);
void Ir_Ultrasonic_avoid(uint16_t distance);

#endif /* ULTRASONIC_APP_ULTRASONIC_H_ */
