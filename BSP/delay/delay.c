#include "delay.h"


static uint32_t g_fac_us = 0;       /* us延时倍乘数 us delay multiplier */

void Delay_Init(void)
{

    g_fac_us = 72;//一般是72 Usually 72
}


/*
 *
 * 函数名: Delay_US
 * 功能描述: 延时nus，nus为要延时的us数(用时钟摘取法来做us延时).
 * 输入参数: nus
 * 输出参数: 无
 *
 * Function name: Delay_US
 * Function description: Delay nus, nus is the number of us to be delayed (use clock extraction method to do us delay).
 * Input parameters: nus
 * Output parameters: None
*/

void Delay_US(uint32_t nus)
{
	uint32_t ticks;
	uint32_t told, tnow, tcnt = 0;
	uint32_t reload = SysTick->LOAD;        /* LOAD的值  LOAD value*/
	ticks = nus * g_fac_us;                 /* 需要的节拍数  number of beats required*/
	 told = SysTick->VAL;                    /* 刚进入时的计数器值  Counter value when first entered*/
	    while (1)
	    {
	        tnow = SysTick->VAL;
	        if (tnow != told)
	        {
	            if (tnow < told)
	            {
	                tcnt += told - tnow;        /* 这里注意一下SYSTICK是一个递减的计数器就可以了 Just note here that SYSTICK is a decrementing counter. */
	            }
	            else
	            {
	                tcnt += reload - tnow + told;
	            }
	            told = tnow;
	            if (tcnt >= ticks)
	            {
	                break;                      /* 时间超过/等于要延迟的时间,则退出 If the time exceeds/is equal to the time to be delayed, exit */
	            }
	        }
	    }
}


/*
 * 函数名: Delay_MS
 * 功能描述: 延时nus，nus为要延时的us数(用时钟摘取法来做us延时).
 * 输入参数: nus
 * 输出参数: 无
 *
 * Function name: Delay_MS
 * Function description: Delay nus, nus is the number of us to be delayed (use clock extraction method to do us delay).
 * Input parameters: nus
 * Output parameters: None
*/

void Delay_MS(uint16_t nms)
{
    Delay_US((uint32_t)(nms * 1000));                   /* 普通方式延时  Normal mode delay*/
}

